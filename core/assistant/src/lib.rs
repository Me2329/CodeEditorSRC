//! CodeCraft Studio assistant.
//!
//! Exposed as a library so the engines can be tested directly, and so a host
//! process can embed them instead of talking to the daemon over a socket.

pub mod index;
pub mod local;
pub mod protocol;
pub mod remote;
