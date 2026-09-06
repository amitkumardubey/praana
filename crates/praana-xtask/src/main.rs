mod unicode;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: praana-xtask <command> [args]");
        eprintln!("Commands:");
        eprintln!("  unicode fetch --version 15.1.0");
        eprintln!("  unicode generate [--offline]");
        eprintln!("  unicode verify --offline");
        std::process::exit(1);
    }

    match args[1].as_str() {
        "unicode" => {
            if let Err(e) = unicode::run(&args[2..]) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
        cmd => {
            eprintln!("Unknown command: {cmd}");
            std::process::exit(1);
        }
    }
}
