use serde::Serialize;

#[derive(Serialize, specta::Type)]
pub struct Shortcut {
    pub command: &'static str,
    pub key: &'static str,
    pub shift: bool,
}

const fn cmd(command: &'static str, key: &'static str) -> Shortcut {
    Shortcut {
        command,
        key,
        shift: false,
    }
}

const fn cmd_shift(command: &'static str, key: &'static str) -> Shortcut {
    Shortcut {
        command,
        key,
        shift: true,
    }
}

pub const SHORTCUTS: &[Shortcut] = &[
    cmd("tab.new", "T"),
    cmd("doc.new", "N"),
    cmd("doc.openFile", "O"),
    cmd("doc.save", "S"),
    cmd_shift("doc.saveAs", "S"),
    cmd("doc.export", "E"),
    cmd_shift("tab.next", "]"),
    cmd_shift("tab.prev", "["),
    cmd("tab.close", "W"),
    cmd("doc.undo", "Z"),
    cmd_shift("doc.redo", "Z"),
    cmd("find.open", "F"),
    cmd("find.next", "G"),
    cmd_shift("find.prev", "G"),
    cmd("find.replace", "H"),
    cmd("palette.toggle", "K"),
    cmd("view.toggleSidebar", "B"),
    cmd("view.tree", "1"),
    cmd("view.code", "2"),
    cmd("view.grid", "3"),
    cmd("view.graph", "4"),
    cmd("nav.settings", ","),
    cmd_shift("view.openSchemaPanel", "V"),
    cmd("compare.pick", "D"),
    cmd("help.shortcuts", "/"),
];

pub fn accelerator(command: &str) -> Option<String> {
    let s = SHORTCUTS.iter().find(|s| s.command == command)?;
    let shift = if s.shift { "Shift+" } else { "" };
    Some(format!("CmdOrCtrl+{shift}{}", s.key))
}
