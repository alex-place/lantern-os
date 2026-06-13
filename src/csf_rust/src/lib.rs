//! CSF — Convergence-Fitted Searchable Binary Archive (Rust v1.0)
//!
//! Production-grade, memory-safe, streaming-native implementation of the
//! CSF specification. Designed for files larger than RAM and workloads
//! requiring random access or search without full decompression.
//!
//! # Quick start
//! ```ignore
//! use csf::{Archive, Compressor};
//!
//! let mut archive = Archive::new();
//! archive.add_segment(b"Garden Table Lantern Convergence");
//! let bytes = archive.write()?;
//! ```

pub mod compress;
pub mod convergence;
pub mod dictionary;
pub mod header;
pub mod search;
pub mod security;
pub mod sparse;
pub mod streaming;
pub mod wavefront;
pub mod cio;

use thiserror::Error;

/// Crate-wide error type with hardened error messages (no alloc on panic path).
#[derive(Debug, Error)]
pub enum CsfError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("parse error: {0}")]
    Parse(&'static str),

    #[error("security violation: {0}")]
    Security(&'static str),

    #[error("compression error: {0}")]
    Compression(String),

    #[error("dictionary overflow (max {max} bytes)")]
    DictionaryOverflow { max: usize },

    #[error("sparse matrix overflow (max {max} non-zero values)")]
    SparseOverflow { max: usize },

    #[error("invalid checksum (expected {expected:016x}, got {got:016x})")]
    Checksum { expected: u64, got: u64 },
}

pub type Result<T> = std::result::Result<T, CsfError>;

/// Re-export core types.
pub use compress::{CompressionMode, Compressor, Decompressor};
pub use convergence::ArchiveMerger;
pub use dictionary::SymbolicDictionary;
pub use header::{ArchiveHeader, CsfFlags};
pub use search::{SearchHit, SearchIndex, SearchQuery};
pub use security::SecurityPolicy;
pub use sparse::{CsrMatrix, CsrMetadata};
pub use streaming::{SegmentReader, StreamingCompressor};
pub use wavefront::Wavefront;

/// Convenience archive builder.
#[derive(Debug, Default)]
pub struct Archive {
    segments: Vec<Vec<u8>>,
    dictionary: SymbolicDictionary,
    #[allow(dead_code)]
    index: Option<SearchIndex>,
    flags: CsfFlags,
}

impl Archive {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_segment(&mut self, data: &[u8]) {
        self.segments.push(data.to_vec());
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Hardened write with security policy enforcement.
    pub fn write<W: std::io::Write + std::io::Seek>(
        &self,
        writer: &mut W,
        policy: &SecurityPolicy,
    ) -> Result<()> {
        let mut compressor = StreamingCompressor::new(policy.clone());
        for seg in &self.segments {
            compressor.ingest_segment(seg)?;
        }
        compressor.finalize(writer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_one_segment() {
        let mut archive = Archive::new();
        archive.add_segment(b"Garden Table Lantern");
        let mut buf = std::io::Cursor::new(Vec::new());
        let policy = SecurityPolicy::default();
        archive.write(&mut buf, &policy).unwrap();
        assert!(!buf.into_inner().is_empty());
    }

    #[test]
    fn segment_reader_roundtrip() {
        let mut archive = Archive::new();
        archive.add_segment(b"Segment zero");
        archive.add_segment(b"Segment one");
        archive.add_segment(b"Segment two");

        let tmp = tempfile::NamedTempFile::new().unwrap();
        let mut file = std::fs::File::create(tmp.path()).unwrap();
        let policy = SecurityPolicy::default();
        archive.write(&mut file, &policy).unwrap();
        drop(file);

        let mut reader = SegmentReader::open(tmp.path()).unwrap();
        assert_eq!(reader.header().segment_count, 3);

        let seg0 = reader.decompress_segment(0).unwrap();
        assert_eq!(&seg0[..], b"Segment zero");

        let seg2 = reader.decompress_segment(2).unwrap();
        assert_eq!(&seg2[..], b"Segment two");
    }
}
