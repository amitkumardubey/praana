use clap::Parser;

#[derive(Debug, Parser)]
#[command(
    name = "praana",
    version,
    about = "PRAANA Rust v2 core (Phase 0 skeleton)"
)]
struct Cli {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn main() {
    let _cli = Cli::parse();
    println!("Rust v2 core is not operational in Phase 0.");
}
