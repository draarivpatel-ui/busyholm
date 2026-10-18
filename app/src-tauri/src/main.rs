// Busyholm shell entry point. Release builds on Windows use the GUI subsystem (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    busyholm_app::run();
}
