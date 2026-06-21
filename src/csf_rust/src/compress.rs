//! End-to-end compression / decompression pipeline.
//!
//! Layered design matching spec §3:
//!   L1: Symbolic dictionary
//!   L2: Sparse CSR
//!   L3: Zstd final pass
//!
//! Fast-mode upgrade: bypass symbolic layer for speed-critical paths.

use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};
use std::io::{Read, Write};

use crate::dictionary::SymbolicDictionary;
use crate::sparse::{decode_sparse, encode_sparse, CsrMetadata};
use crate::{CsfError, Result, SecurityPolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionMode {
    /// Full symbolic pipeline (best ratio, slowest).
    Full,
    /// Skip dictionary for small inputs; use raw zstd.
    Fast,
    /// Use pre-built static dictionary (no training).
    Static,
}

/// In-memory compressor for moderate-size inputs.
pub struct Compressor {
    dictionary: SymbolicDictionary,
    policy: SecurityPolicy,
    block_size: usize,
}

impl Compressor {
    pub fn new(policy: SecurityPolicy) -> Self {
        Self {
            dictionary: SymbolicDictionary::new(),
            policy,
            block_size: 512,
        }
    }

    pub fn with_block_size(mut self, size: usize) -> Self {
        self.block_size = size;
        self
    }

    /// Compress UTF-8 text using dictionary + sparse + zstd.
    pub fn compress_text(&mut self, text: &str) -> Result<Vec<u8>> {
        self.compress_text_mode(text, CompressionMode::Full)
    }

    /// Compress with selectable mode.
    pub fn compress_text_mode(&mut self, text: &str, mode: CompressionMode) -> Result<Vec<u8>> {
        match mode {
            CompressionMode::Full => self.compress_full(text),
            CompressionMode::Fast => self.compress_fast(text),
            CompressionMode::Static => self.compress_static(text),
        }
    }

    fn compress_full(&mut self, text: &str) -> Result<Vec<u8>> {
        let tokens = tokenize(text);
        self.dictionary.train(
            tokens.iter().cloned(),
            3, // min_freq
            &self.policy,
        )?;

        let ids: Vec<u16> = tokens.iter().map(|t| self.dictionary.encode(t)).collect();
        let id_bytes = pack_varints(&ids);

        let (meta, sparse_compressed) = encode_sparse(&id_bytes, 0, self.block_size, &self.policy)?;

        let mut body = Vec::new();
        let dict_bytes = self.dictionary.to_bytes()?;
        body.write_u32::<BigEndian>(dict_bytes.len() as u32)?;
        body.write_all(&dict_bytes)?;
        meta.write(&mut body)?;
        body.write_all(&sparse_compressed)?;

        // Level 19: full mode optimizes ratio, not speed. Measured ~1.9x smaller
        // than level 3 on real JSONL memory (experiments/csf_compression_benchmark.py).
        const ZSTD_FULL_LEVEL: i32 = 19;
        let final_compressed = zstd::encode_all(&body[..], ZSTD_FULL_LEVEL)
            .map_err(|e| CsfError::Compression(e.to_string()))?;
        Ok(final_compressed)
    }

    /// Fast mode: skip symbolic layer for small inputs.
    /// For inputs below threshold, raw zstd is faster than tokenization overhead.
    fn compress_fast(&mut self, text: &str) -> Result<Vec<u8>> {
        const FAST_THRESHOLD_BYTES: usize = 512_000; // 512 KB
        let data = text.as_bytes();
        if data.len() < FAST_THRESHOLD_BYTES {
            // Just zstd with a header flag indicating fast mode
            let mut out = Vec::with_capacity(8 + data.len());
            out.write_u32::<BigEndian>(0xFFFFFFFF)?; // magic: no dictionary
            out.write_u32::<BigEndian>(data.len() as u32)?;
            let compressed = zstd::encode_all(data, 1) // level 1 = speed
                .map_err(|e| CsfError::Compression(e.to_string()))?;
            out.write_all(&compressed)?;
            return Ok(out);
        }
        // Large inputs: fall back to full mode
        self.compress_full(text)
    }

    /// Static mode: use pre-built dictionary, no training.
    /// Placeholder: in production, load dictionary from embedded asset.
    fn compress_static(&mut self, text: &str) -> Result<Vec<u8>> {
        // For now, identical to full but could skip training if dict pre-loaded
        self.compress_full(text)
    }

    pub fn dictionary_size(&self) -> usize {
        self.dictionary.vocab_size()
    }
}

/// In-memory decompressor.
pub struct Decompressor;

impl Decompressor {
    pub fn decompress(data: &[u8], policy: &SecurityPolicy) -> Result<Vec<u8>> {
        let body = zstd::decode_all(data).map_err(|e| CsfError::Compression(e.to_string()))?;
        let mut cursor = std::io::Cursor::new(&body);

        let dict_len = cursor.read_u32::<BigEndian>()? as usize;
        policy.check_dictionary(dict_len)?;
        let mut dict_buf = vec![0u8; dict_len];
        cursor.read_exact(&mut dict_buf)?;
        let dictionary = SymbolicDictionary::read(&mut &dict_buf[..], policy)?;

        let meta = CsrMetadata::read(&mut cursor)?;
        let sparse_len = body.len() - cursor.position() as usize;
        let mut sparse_buf = vec![0u8; sparse_len];
        cursor.read_exact(&mut sparse_buf)?;

        let id_bytes = decode_sparse(&meta, &sparse_buf)?;
        let ids = unpack_varints(&id_bytes);
        let mut output = String::with_capacity(ids.len() * 8);
        for id in ids {
            if let Some(token) = dictionary.decode(id) {
                output.push_str(token);
                output.push(' ');
            } else {
                output.push('?');
            }
        }
        Ok(output.into_bytes())
    }
}

// --- helpers ---

fn tokenize(text: &str) -> Vec<String> {
    // Simple whitespace + punctuation tokenizer (matches Python v0.7)
    let mut tokens = Vec::new();
    for word in text.split_whitespace() {
        tokens.push(word.to_string());
    }
    tokens
}

fn pack_varints(values: &[u16]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(values.len() * 2);
    for &v in values {
        let mut v = v as u32;
        while v >= 128 {
            buf.push((v & 0x7F) as u8 | 0x80);
            v >>= 7;
        }
        buf.push(v as u8);
    }
    buf
}

fn unpack_varints(data: &[u8]) -> Vec<u16> {
    let mut values = Vec::new();
    let mut i = 0;
    while i < data.len() {
        let mut v: u32 = 0;
        let mut shift = 0;
        loop {
            let b = data[i];
            i += 1;
            v |= ((b & 0x7F) as u32) << shift;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
            if shift > 21 {
                break; // overflow guard
            }
        }
        values.push(v as u16);
    }
    values
}

// --- trait impls for CsrMetadata to live here (convenience) ---

impl CsrMetadata {
    pub fn write<W: Write>(&self, writer: &mut W) -> Result<()> {
        writer.write_u32::<BigEndian>(self.original_len as u32)?;
        writer.write_u32::<BigEndian>(self.block_size as u32)?;
        writer.write_u32::<BigEndian>(self.default_value as u32)?;
        writer.write_u32::<BigEndian>(self.num_blocks as u32)?;
        Ok(())
    }

    pub fn read<R: Read>(reader: &mut R) -> Result<Self> {
        Ok(Self {
            original_len: reader.read_u32::<BigEndian>()? as usize,
            block_size: reader.read_u32::<BigEndian>()? as usize,
            default_value: reader.read_u32::<BigEndian>()? as u8,
            num_blocks: reader.read_u32::<BigEndian>()? as usize,
        })
    }
}
