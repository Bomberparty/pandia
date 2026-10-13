use serde::Serialize;
use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

// Set on the app process the launcher starts, so that process opens the window instead of
// launching again.
pub(crate) const LAUNCHED_ENV: &str = "PANDIA_LAUNCHED";

// The launcher and the app may be different processes, so piped input and `--wait` results
// travel through temp files. The app only reads, deletes or writes files with these prefixes.
const STDIN_PREFIX: &str = "pandia-stdin-";
const WAIT_PREFIX: &str = "pandia-wait-";
const STDIN_FILE_FLAG: &str = "--stdin-file";
const WAIT_ID_FLAG: &str = "--wait-id";

const USAGE: &str = "\
Usage: pandia [options] [file ...]

  pandia data.json                      open files in Pandia
  curl -s https://api.dev/x | pandia -  open what is piped in
  pandia --diff old.json new.json       compare two files

Options:
  --schema <path|url>  validate the opened files against this schema
  --diff <a> <b>       open <a> in Compare against <b>
  --wait               return after you close the opened tabs. Exits 1 if
                       a file didn't open or the Schema panel shows errors
  -h, --help           show this help
";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingFile {
    pub path: String,
    pub piped: bool,
    pub schema: Option<String>,
    pub compare_with: Option<String>,
    pub wait: Option<String>,
}

impl PendingFile {
    pub fn file(path: String) -> Self {
        Self {
            path,
            piped: false,
            schema: None,
            compare_with: None,
            wait: None,
        }
    }
}

#[derive(Debug, Default, PartialEq)]
struct Request {
    files: Vec<String>,
    schema: Option<String>,
    diff: Option<(String, String)>,
    stdin: bool,
    wait: bool,
    help: bool,
    stdin_file: Option<String>,
    wait_id: Option<String>,
    problems: Vec<String>,
}

fn parse(args: impl IntoIterator<Item = String>) -> Request {
    let mut req = Request::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "-" => req.stdin = true,
            "-h" | "--help" => req.help = true,
            "--wait" => req.wait = true,
            "--schema" => match inline.or_else(|| args.next()) {
                Some(value) => req.schema = Some(value),
                None => req
                    .problems
                    .push("--schema needs a path or URL after it.".into()),
            },
            "--diff" => match (args.next(), args.next()) {
                (Some(a), Some(b)) => req.diff = Some((a, b)),
                _ => req
                    .problems
                    .push("--diff needs two files, like: pandia --diff old.json new.json".into()),
            },
            STDIN_FILE_FLAG => req.stdin_file = inline,
            WAIT_ID_FLAG => req.wait_id = inline,
            _ if arg.starts_with('-') => req.problems.push(format!(
                "{arg} isn't a Pandia option. Run pandia --help to see the options."
            )),
            _ => req.files.push(arg),
        }
    }
    req
}

// A relative path on the command line means "relative to where the command ran", which
// only the launching process knows, so it is made absolute here. URLs pass through.
fn resolve_reference(reference: &str, cwd: &Path) -> String {
    if reference.contains("://") || Path::new(reference).is_absolute() {
        return reference.to_string();
    }
    cwd.join(reference).to_string_lossy().into_owned()
}

fn is_handoff(path: &str, prefix: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix))
}

pub(crate) fn is_stdin_handoff(path: &str) -> bool {
    is_handoff(path, STDIN_PREFIX)
}

/// Turns the arguments of a launch into the tabs to open, registering its hand-off files.
pub(crate) fn pending_from(
    args: impl IntoIterator<Item = String>,
    cwd: &Path,
    handoffs: &Handoffs,
) -> Vec<PendingFile> {
    let req = parse(args);
    let resolve = |reference: &str| resolve_reference(reference, cwd);
    let schema = req.schema.as_deref().map(resolve);
    let wait = req.wait_id.filter(|id| is_handoff(id, WAIT_PREFIX));

    let mut opens: Vec<(String, bool, Option<String>)> = req
        .files
        .iter()
        .map(|f| (resolve(f), false, None))
        .collect();
    if let Some((a, b)) = &req.diff {
        opens.push((resolve(a), false, Some(resolve(b))));
    }
    if let Some(path) = req.stdin_file.filter(|p| is_handoff(p, STDIN_PREFIX)) {
        handoffs.lock().piped.push(path.clone());
        opens.push((path, true, None));
    }

    if let Some(id) = &wait {
        handoffs.expect(id, opens.len());
    }
    opens
        .into_iter()
        .map(|(path, piped, compare_with)| PendingFile {
            path,
            piped,
            schema: schema.clone(),
            compare_with,
            wait: wait.clone(),
        })
        .collect()
}

/// The hand-off files of every launch: the tabs each `--wait` is waiting on, and piped input,
/// which stays on disk while its tab is open so auto-repair can read it again.
#[derive(Default)]
pub(crate) struct Handoffs(Mutex<HandoffFiles>);

#[derive(Default)]
pub(crate) struct HandoffFiles {
    waits: HashMap<String, (usize, i32)>,
    piped: Vec<String>,
}

impl Handoffs {
    fn lock(&self) -> std::sync::MutexGuard<'_, HandoffFiles> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn expect(&self, id: &str, tabs: usize) {
        if tabs == 0 {
            return finish_wait(id, 0);
        }
        self.lock().waits.entry(id.to_string()).or_insert((0, 0)).0 += tabs;
    }

    pub fn release(&self, id: &str, code: i32) {
        let mut files = self.lock();
        let Some((open, worst)) = files.waits.get_mut(id) else {
            return;
        };
        *open = open.saturating_sub(1);
        *worst = (*worst).max(code);
        if *open == 0 {
            finish_wait(id, *worst);
            files.waits.remove(id);
        }
    }

    pub fn discard_piped(&self, path: &str) {
        let mut files = self.lock();
        if let Some(i) = files.piped.iter().position(|p| p == path) {
            let _ = std::fs::remove_file(files.piped.swap_remove(i));
        }
    }

    pub fn finish_all(&self) {
        let mut files = self.lock();
        for (id, (_, worst)) in files.waits.drain() {
            finish_wait(&id, worst);
        }
        for path in files.piped.drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn finish_wait(id: &str, code: i32) {
    let _ = std::fs::write(id, code.to_string());
}

/// Runs when `pandia …` is typed in a terminal: hands the request to the app in a detached
/// process, so the shell gets its prompt back and closing the terminal doesn't quit Pandia.
pub(crate) fn launch(args: Vec<String>) -> i32 {
    let req = parse(args.iter().cloned());
    if req.help {
        print!("{USAGE}");
        return 0;
    }
    if let Some(problem) = req.problems.first() {
        eprintln!("pandia: {problem}");
        return 2;
    }
    match hand_off(&req, args) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("pandia: {message}");
            2
        }
    }
}

fn hand_off(req: &Request, args: Vec<String>) -> Result<i32, String> {
    let opens_something = !req.files.is_empty() || req.diff.is_some() || req.stdin;
    if req.wait && !opens_something {
        return Err("--wait needs a file to open, like: pandia --wait config.json".into());
    }
    let mut app_args: Vec<String> = args.into_iter().filter(|a| a != "-").collect();
    if req.stdin {
        let saved = save_stdin()?;
        app_args.push(format!("{STDIN_FILE_FLAG}={}", saved.display()));
    }
    let marker = req.wait.then(|| handoff_path(WAIT_PREFIX, ""));
    if let Some(marker) = &marker {
        app_args.push(format!("{WAIT_ID_FLAG}={}", marker.display()));
    }
    spawn_app(&app_args)?;
    Ok(marker.map_or(0, |m| wait_for(&m)))
}

fn handoff_path(prefix: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{prefix}{}{ext}", uuid::Uuid::new_v4().simple()))
}

fn save_stdin() -> Result<PathBuf, String> {
    let mut stdin = std::io::stdin().lock();
    if stdin.is_terminal() {
        return Err(
            "nothing was piped in. Use it like: curl -s https://api.example.com/users | pandia -"
                .into(),
        );
    }
    let path = handoff_path(STDIN_PREFIX, ".json");
    let copied = create_private(&path).and_then(|mut f| std::io::copy(&mut stdin, &mut f));
    match copied {
        Ok(bytes) if bytes > 0 => Ok(path),
        Ok(_) => {
            let _ = std::fs::remove_file(&path);
            Err("the piped input was empty, so there is nothing to open.".into())
        }
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            Err(format!(
                "couldn't save the piped input in {}. Check that the folder exists and the disk has free space.",
                std::env::temp_dir().display()
            ))
        }
    }
}

// Piped input can be a secret, and /tmp on Linux is shared by every user on the machine.
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// The file that starts Pandia. An AppImage's own files disappear when its first process
/// exits, so on Linux the AppImage itself is started instead.
pub(crate) fn app_executable() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Some(appimage.into());
    }
    let exe = std::env::current_exe().ok()?;
    // Windows canonical paths carry a \\?\ prefix that other tools don't accept.
    #[cfg(not(windows))]
    let exe = exe.canonicalize().ok()?;
    Some(exe)
}

fn spawn_app(args: &[String]) -> Result<(), String> {
    let failed = || "couldn't start Pandia. Reinstall Pandia, then try again.".to_string();
    let mut cmd = Command::new(app_executable().ok_or_else(failed)?);
    cmd.args(args)
        .env(LAUNCHED_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(drop).map_err(|_| failed())
}

fn wait_for(marker: &Path) -> i32 {
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(text) = std::fs::read_to_string(marker) {
            if let Ok(code) = text.trim().parse() {
                let _ = std::fs::remove_file(marker);
                return code;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn pending(list: &[&str]) -> Vec<PendingFile> {
        pending_from(args(list), Path::new("/work"), &Handoffs::default())
    }

    #[test]
    fn schema_flag_attaches_to_files_and_is_not_opened_itself() {
        let got = pending(&["config.json", "--schema", "./config.schema.json"]);
        assert_eq!(
            got,
            vec![PendingFile {
                schema: Some("/work/./config.schema.json".into()),
                ..PendingFile::file("/work/config.json".into())
            }]
        );
    }

    #[test]
    fn schema_equals_form_urls_and_absolute_paths_pass_through() {
        let url = pending(&["--schema=https://x.dev/s.json", "a.json"]);
        assert_eq!(url[0].schema.as_deref(), Some("https://x.dev/s.json"));
        let abs = pending(&["a.json", "--schema", "/etc/s.json"]);
        assert_eq!(abs[0].schema.as_deref(), Some("/etc/s.json"));
    }

    #[test]
    fn opens_every_named_file_whatever_its_extension() {
        let got = pending(&["a.json", "notes.txt"]);
        assert_eq!(got[1], PendingFile::file("/work/notes.txt".into()));
    }

    #[test]
    fn diff_opens_the_first_file_against_the_second() {
        let got = pending(&["--diff", "old.json", "/tmp/new.json"]);
        assert_eq!(
            got,
            vec![PendingFile {
                compare_with: Some("/tmp/new.json".into()),
                ..PendingFile::file("/work/old.json".into())
            }]
        );
    }

    #[test]
    fn launcher_reports_mistakes_in_plain_words() {
        assert_eq!(
            parse(args(&["--diff", "a.json"])).problems,
            ["--diff needs two files, like: pandia --diff old.json new.json"]
        );
        assert_eq!(
            parse(args(&["--schema"])).problems,
            ["--schema needs a path or URL after it."]
        );
        assert_eq!(
            parse(args(&["--verbose"])).problems,
            ["--verbose isn't a Pandia option. Run pandia --help to see the options."]
        );
    }

    #[test]
    fn handoff_files_must_carry_pandias_prefix() {
        let got = pending(&["--stdin-file=/tmp/pandia-stdin-1.json"]);
        assert_eq!(got.len(), 1);
        assert!(got[0].piped);
        assert!(pending(&["--stdin-file=/home/me/important.json"]).is_empty());
        let waits = Handoffs::default();
        let got = pending_from(
            args(&["a.json", "--wait-id=/home/me/notes.txt"]),
            Path::new("/w"),
            &waits,
        );
        assert_eq!(got[0].wait, None);
    }

    #[test]
    fn wait_reports_the_worst_code_once_every_tab_is_closed() {
        let dir = std::env::temp_dir().join(format!("pandia-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pandia-wait-test");
        let id = marker.to_string_lossy().into_owned();
        let waits = Handoffs::default();
        let flag = format!("--wait-id={id}");
        let got = pending_from(args(&["a.json", "b.json", &flag]), &dir, &waits);
        assert!(got.iter().all(|p| p.wait.as_deref() == Some(id.as_str())));

        waits.release(&id, 1);
        assert!(!marker.exists());
        waits.release(&id, 0);
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "1");
        assert_eq!(wait_for(&marker), 1);
        assert!(!marker.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wait_with_nothing_to_open_finishes_at_once() {
        let dir = std::env::temp_dir().join(format!("pandia-cli-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pandia-wait-none");
        let flag = format!("--wait-id={}", marker.display());
        let got = pending_from(args(&[&flag]), &dir, &Handoffs::default());
        assert!(got.is_empty());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "0");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn quitting_deletes_piped_input_and_answers_open_waits() {
        let dir = std::env::temp_dir().join(format!("pandia-cli-quit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let piped = dir.join("pandia-stdin-quit.json");
        std::fs::write(&piped, "[]").unwrap();
        let marker = dir.join("pandia-wait-quit");
        let handoffs = Handoffs::default();
        let stdin_flag = format!("--stdin-file={}", piped.display());
        let wait_flag = format!("--wait-id={}", marker.display());
        pending_from(args(&[&stdin_flag, &wait_flag]), &dir, &handoffs);

        handoffs.finish_all();
        assert!(!piped.exists());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "0");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn closing_the_tab_deletes_only_its_own_piped_input() {
        let dir = std::env::temp_dir().join(format!("pandia-cli-close-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let piped = dir.join("pandia-stdin-close.json");
        let stranger = dir.join("pandia-stdin-stranger.json");
        std::fs::write(&piped, "[]").unwrap();
        std::fs::write(&stranger, "[]").unwrap();
        let handoffs = Handoffs::default();
        let flag = format!("--stdin-file={}", piped.display());
        pending_from(args(&[&flag]), &dir, &handoffs);

        handoffs.discard_piped(&stranger.to_string_lossy());
        assert!(
            stranger.exists(),
            "files no launch handed over are left alone"
        );
        handoffs.discard_piped(&piped.to_string_lossy());
        assert!(!piped.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn piped_input_is_saved_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pandia-cli-perm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pandia-stdin-perm.json");
        create_private(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(
            create_private(&path).is_err(),
            "an existing file is never reused"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
