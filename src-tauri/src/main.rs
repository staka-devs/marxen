#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Start the desktop application through the library's configured runtime entry point.
fn main() {
    marxen_lib::run();
}
