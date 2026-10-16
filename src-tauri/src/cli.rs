use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

pub(crate) const LAUNCHED_ENV: &str = "PANDIA_LAUNCHED";

const STDIN_PREFIX: &str = "pandia-stdin-";
const WAIT_PREFIX: &str = "pandia-wait-";
const REPLY_PREFIX: &str = "pandia-reply-";
const STDIN_FILE_FLAG: &str = "--stdin-file";
const WAIT_ID_FLAG: &str = "--wait-id";
const REPLY_FILE_FLAG: &str = "--reply-file";

const USAGE: &str = "\
Usage: pandia [options] [file ...]

  pandia data.json                      open files in Pandia
  curl -s https://api.dev/x | pandia -  open what is piped in
  pandia --diff old.json new.json       compare two files
  pandia --wait - < in.json > out.json  edit piped JSON; save to send it back

Options:
  --schema <path|url>  validate the opened files against this schema
  --diff <a> <b>       open <a> in Compare against <b>
  --wait               return after you close the opened tabs
  --json               with --wait, print a JSON report of what happened
  -h, --help           show this help

Exit codes with --wait:
  0  the tabs closed and the Schema panel showed no errors
  1  a file didn't open, or the Schema panel showed errors
  2  the command was mistyped
  3  piped input closed without saving, so nothing was sent back
";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingFile {
    pub path: String,
    pub piped: bool,
    pub schema: Option<String>,
    pub compare_with: Option<String>,
    pub wait: Option<String>,
    pub reply: Option<String>,
}

impl PendingFile {
    pub fn file(path: String) -> Self {
        Self {
            path,
            piped: false,
            schema: None,
            compare_with: None,
            wait: None,
            reply: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TabReport {
    pub path: Option<String>,
    pub opened: bool,
    pub saved: bool,
    pub valid: Option<bool>,
    pub error_count: u32,
    pub errors: Vec<ReportError>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportError {
    pub pointer: String,
    pub message: String,
}

impl TabReport {
    fn exit_code(&self) -> i32 {
        let failed = !self.opened || self.problem.is_some() || self.valid == Some(false);
        i32::from(failed)
    }
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitReport {
    exit_code: i32,
    files: Vec<TabReport>,
}

#[derive(Debug, Default, PartialEq)]
struct Request {
    files: Vec<String>,
    schema: Option<String>,
    diff: Option<(String, String)>,
    stdin: bool,
    wait: bool,
    json: bool,
    help: bool,
    stdin_file: Option<String>,
    wait_id: Option<String>,
    reply_file: Option<String>,
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
            "--json" => req.json = true,
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
            REPLY_FILE_FLAG => req.reply_file = inline,
            _ if arg.starts_with('-') => req.problems.push(format!(
                "{arg} isn't a Pandia option. Run pandia --help to see the options."
            )),
            _ => req.files.push(arg),
        }
    }
    if req.json && !req.wait {
        req.problems.push(
            "--json reports what happened when you close the tabs, so it needs --wait, like: pandia --wait --json config.json".into(),
        );
    }
    req
}

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

pub(crate) fn pending_from(
    args: impl IntoIterator<Item = String>,
    cwd: &Path,
    handoffs: &Handoffs,
) -> Vec<PendingFile> {
    let req = parse(args);
    let resolve = |reference: &str| resolve_reference(reference, cwd);
    let schema = req.schema.as_deref().map(resolve);
    let wait = req.wait_id.filter(|id| is_handoff(id, WAIT_PREFIX));

    let file = |path: String| PendingFile {
        schema: schema.clone(),
        wait: wait.clone(),
        ..PendingFile::file(path)
    };

    let mut opens: Vec<PendingFile> = req.files.iter().map(|f| file(resolve(f))).collect();
    if let Some((a, b)) = &req.diff {
        opens.push(PendingFile {
            compare_with: Some(resolve(b)),
            ..file(resolve(a))
        });
    }
    if let Some(path) = req.stdin_file.filter(|p| is_handoff(p, STDIN_PREFIX)) {
        let reply = req.reply_file.filter(|p| is_handoff(p, REPLY_PREFIX));
        let mut files = handoffs.lock();
        files.piped.push(path.clone());
        files.replies.extend(reply.clone());
        drop(files);
        opens.push(PendingFile {
            piped: true,
            reply,
            ..file(path)
        });
    }

    if let Some(id) = &wait {
        handoffs.expect(id, opens.len());
    }
    opens
}

pub(crate) fn is_reply(handoffs: &Handoffs, path: &str) -> bool {
    handoffs.lock().replies.iter().any(|p| p == path)
}

#[derive(Default)]
pub(crate) struct Handoffs(Mutex<HandoffFiles>);

#[derive(Default)]
pub(crate) struct HandoffFiles {
    waits: HashMap<String, (usize, Vec<TabReport>)>,
    piped: Vec<String>,
    replies: Vec<String>,
}

impl Handoffs {
    fn lock(&self) -> std::sync::MutexGuard<'_, HandoffFiles> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn expect(&self, id: &str, tabs: usize) {
        if tabs == 0 {
            return finish_wait(id, Vec::new());
        }
        self.lock().waits.entry(id.to_string()).or_default().0 += tabs;
    }

    pub fn release(&self, id: &str, report: TabReport) {
        let mut files = self.lock();
        let Some((open, reports)) = files.waits.get_mut(id) else {
            return;
        };
        *open = open.saturating_sub(1);
        reports.push(report);
        if *open == 0 {
            if let Some((_, reports)) = files.waits.remove(id) {
                finish_wait(id, reports);
            }
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
        for (id, (_, reports)) in files.waits.drain() {
            finish_wait(&id, reports);
        }
        for path in files.piped.drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn finish_wait(id: &str, files: Vec<TabReport>) {
    let exit_code = files.iter().map(TabReport::exit_code).max().unwrap_or(0);
    if let Ok(json) = serde_json::to_string(&WaitReport { exit_code, files }) {
        let _ = std::fs::write(id, json);
    }
}

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
        Ok((code, out)) => {
            print!("{out}");
            code
        }
        Err(message) => {
            eprintln!("pandia: {message}");
            2
        }
    }
}

fn hand_off(req: &Request, args: Vec<String>) -> Result<(i32, String), String> {
    let opens_something = !req.files.is_empty() || req.diff.is_some() || req.stdin;
    if req.wait && !opens_something {
        return Err("--wait needs a file to open, like: pandia --wait config.json".into());
    }
    let mut app_args: Vec<String> = args.into_iter().filter(|a| a != "-").collect();
    if req.stdin {
        let saved = save_stdin()?;
        app_args.push(format!("{STDIN_FILE_FLAG}={}", saved.display()));
    }
    let reply = if req.stdin && req.wait {
        let path = handoff_path(REPLY_PREFIX, ".json");
        create_private(&path).map_err(|_| {
            format!(
                "couldn't prepare a reply file in {}. Check that the folder exists and the disk has free space.",
                std::env::temp_dir().display()
            )
        })?;
        app_args.push(format!("{REPLY_FILE_FLAG}={}", path.display()));
        Some(path)
    } else {
        None
    };
    let marker = req.wait.then(|| handoff_path(WAIT_PREFIX, ""));
    if let Some(marker) = &marker {
        app_args.push(format!("{WAIT_ID_FLAG}={}", marker.display()));
    }
    spawn_app(&app_args)?;
    let Some(marker) = marker else {
        return Ok((0, String::new()));
    };
    let report = wait_for(&marker);
    let reply_text = reply.map(|path| {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let _ = std::fs::remove_file(&path);
        text
    });
    Ok(finish(report, reply_text, req.json))
}

fn finish(mut report: WaitReport, reply: Option<String>, json: bool) -> (i32, String) {
    let reply = reply.map(|text| (!text.trim().is_empty()).then_some(text));
    let unsent = matches!(reply, Some(None));
    if let Some(stdin_tab) = report.files.iter_mut().find(|f| f.path.is_none()) {
        stdin_tab.saved = !unsent;
    }
    let code = if unsent {
        report.exit_code.max(3)
    } else {
        report.exit_code
    };
    let content = reply.flatten();
    if !json {
        return (code, content.unwrap_or_default());
    }
    report.exit_code = code;
    let mut value = serde_json::to_value(&report).unwrap_or_default();
    if let (Some(text), Some(files)) = (content, value["files"].as_array_mut()) {
        let parsed = crate::doc::lazy::parse_json(&text).unwrap_or(serde_json::Value::String(text));
        if let Some(stdin_tab) = files.iter_mut().find(|f| f["path"].is_null()) {
            stdin_tab["content"] = parsed;
        }
    }
    (code, format!("{value:#}\n"))
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

pub(crate) fn app_executable() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Some(appimage.into());
    }
    let exe = std::env::current_exe().ok()?;
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

fn wait_for(marker: &Path) -> WaitReport {
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(text) = std::fs::read_to_string(marker) {
            if let Ok(report) = serde_json::from_str(&text) {
                let _ = std::fs::remove_file(marker);
                return report;
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

    fn report(path: &str) -> TabReport {
        TabReport {
            path: Some(path.into()),
            opened: true,
            saved: false,
            valid: None,
            error_count: 0,
            errors: vec![],
            problem: None,
        }
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

        let invalid = TabReport {
            valid: Some(false),
            error_count: 1,
            errors: vec![ReportError {
                pointer: "/retries".into(),
                message: "\"3\" is not of type \"integer\"".into(),
            }],
            ..report("/w/a.json")
        };
        waits.release(&id, invalid.clone());
        assert!(!marker.exists());
        waits.release(&id, report("/w/b.json"));
        let got = wait_for(&marker);
        assert_eq!(got.exit_code, 1);
        assert_eq!(got.files, vec![invalid, report("/w/b.json")]);
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
        assert_eq!(wait_for(&marker).exit_code, 0);
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
        assert_eq!(wait_for(&marker).exit_code, 0);
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

    #[test]
    fn a_tab_fails_when_it_did_not_open_or_its_schema_did_not_pass() {
        assert_eq!(report("/w/a.json").exit_code(), 0);
        let not_opened = TabReport {
            opened: false,
            problem: Some("no file".into()),
            ..report("/w/a.json")
        };
        assert_eq!(not_opened.exit_code(), 1);
        let bad_schema = TabReport {
            problem: Some("This schema can't be used.".into()),
            ..report("/w/a.json")
        };
        assert_eq!(bad_schema.exit_code(), 1);
    }

    #[test]
    fn json_needs_wait() {
        assert_eq!(
            parse(args(&["--json", "a.json"])).problems,
            ["--json reports what happened when you close the tabs, so it needs --wait, like: pandia --wait --json config.json"]
        );
        assert!(parse(args(&["--wait", "--json", "a.json"]))
            .problems
            .is_empty());
    }

    #[test]
    fn piped_input_carries_its_reply_file() {
        let got = pending(&[
            "--stdin-file=/tmp/pandia-stdin-1.json",
            "--reply-file=/tmp/pandia-reply-1.json",
        ]);
        assert_eq!(got[0].reply.as_deref(), Some("/tmp/pandia-reply-1.json"));
        let got = pending(&[
            "--stdin-file=/tmp/pandia-stdin-1.json",
            "--reply-file=/home/me/config.json",
        ]);
        assert_eq!(got[0].reply, None);
    }

    #[test]
    fn saved_piped_input_goes_to_stdout_with_the_tab_exit_code() {
        let stdin_tab = TabReport {
            path: None,
            saved: true,
            ..report("")
        };
        let done = WaitReport {
            exit_code: 0,
            files: vec![stdin_tab],
        };
        let (code, out) = finish(done, Some("{\"a\": 2}".into()), false);
        assert_eq!((code, out.as_str()), (0, "{\"a\": 2}"));
    }

    #[test]
    fn piped_input_closed_without_saving_sends_nothing_and_exits_3() {
        let stdin_tab = TabReport {
            path: None,
            ..report("")
        };
        let done = WaitReport {
            exit_code: 0,
            files: vec![stdin_tab],
        };
        let (code, out) = finish(done, Some(String::new()), false);
        assert_eq!((code, out.as_str()), (3, ""));
    }

    #[test]
    fn json_report_names_each_file_and_embeds_the_piped_reply() {
        let stdin_tab = TabReport {
            path: None,
            ..report("")
        };
        let invalid = TabReport {
            valid: Some(false),
            error_count: 1,
            errors: vec![ReportError {
                pointer: "/retries".into(),
                message: "not an integer".into(),
            }],
            ..report("/w/config.json")
        };
        let done = WaitReport {
            exit_code: 1,
            files: vec![invalid, stdin_tab],
        };
        let (code, out) = finish(done, Some("{\"a\": 2}".into()), true);
        assert_eq!(code, 1);
        let got: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(got["exitCode"], 1);
        assert_eq!(got["files"][0]["errors"][0]["pointer"], "/retries");
        assert_eq!(got["files"][1]["saved"], true);
        assert_eq!(got["files"][1]["content"]["a"].to_string(), "2");
    }
}
