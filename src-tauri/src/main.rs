// Windows release 版不要彈出主控台視窗
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    leo_work_lib::run()
}
