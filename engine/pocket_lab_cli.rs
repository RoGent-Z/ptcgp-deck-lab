use std::io::{self, BufRead, Write};
use serde_json::json;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }
        let response = deckgym::pocket_lab::dispatch(line.as_bytes()).unwrap_or_else(|e| json!({"error": e}));
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
