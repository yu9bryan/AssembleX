// Release 版不要跳出主控台視窗（Windows）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    assemblex_studio_lib::run()
}
