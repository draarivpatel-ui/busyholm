//! One bounded POST to the loopback receiver, written by hand on `std::net` (no HTTP crate).
//!
//! Every step (connect, write, wait for the reply) is clipped to one absolute deadline, so a
//! receiver that is down, hangs, drips bytes or returns an error can never hold the shim past
//! its budget. The target is always 127.0.0.1; nothing here can reach another host.

use crate::runtime::Runtime;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::{Duration, Instant};

pub const TOKEN_HEADER: &str = "X-Busyholm-Token";
pub const AGENT_HEADER: &str = "X-Busyholm-Agent";

fn left(deadline: Instant) -> io::Result<Duration> {
    let d = deadline.saturating_duration_since(Instant::now());
    if d < Duration::from_millis(2) {
        Err(io::ErrorKind::TimedOut.into())
    } else {
        Ok(d)
    }
}

/// The HTTP status code of the reply, once its first line has arrived.
fn status_of(head: &[u8]) -> Option<u16> {
    let line_end = head.iter().position(|&b| b == b'\r' || b == b'\n')?;
    let line = std::str::from_utf8(&head[..line_end]).ok()?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// POST `body` to `/e/<secret>`. Returns the status code when a reply line arrived in time.
pub fn post(rt: &Runtime, agent: &str, body: &[u8], deadline: Instant) -> io::Result<u16> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, rt.port));
    let mut stream = TcpStream::connect_timeout(&addr, left(deadline)?.min(Duration::from_millis(400)))?;
    let _ = stream.set_nodelay(true);
    let head = format!(
        "POST /e/{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\n{}: {}\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        rt.secret,
        rt.port,
        TOKEN_HEADER,
        rt.token,
        AGENT_HEADER,
        agent,
        body.len()
    );
    stream.set_write_timeout(Some(left(deadline)?))?;
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    // Wait for the status line: a 204 is only sent after the event was accepted.
    let mut got = Vec::with_capacity(64);
    let mut chunk = [0u8; 256];
    loop {
        if let Some(code) = status_of(&got) {
            return Ok(code);
        }
        if got.len() > 2048 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        stream.set_read_timeout(Some(left(deadline)?))?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}
