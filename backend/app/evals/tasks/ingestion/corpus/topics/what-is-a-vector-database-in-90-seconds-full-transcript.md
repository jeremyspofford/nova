---
type: topic
title: What is a vector database? In 90 seconds — full transcript
priority: 0
source_type: media_transcript
enabled: true
description: Full captions transcript of What is a vector database? In 90 seconds
category: knowledge
tags: [media, transcript, what-is-a-vector-database-in-90-seconds]
source_url: https://www.youtube.com/watch?v=vDb90SEC0N
timestamp: 2026-07-24T09:31:02.884511+00:00
---

[0:00] A vector database stores embeddings — arrays of floats that place a
piece of text, an image, or an audio clip somewhere in a high-dimensional
space where nearby means similar.

[0:18] The query is the same operation as the write: embed the thing you are
looking for, then find its nearest neighbours. Exact nearest-neighbour search
is linear in the number of vectors, so real systems use an approximate index
— HNSW graphs most often, IVF with product quantization when memory is tight.

[0:47] The tradeoff you are choosing is recall against latency and memory.
HNSW gives you high recall at low latency and costs you RAM; IVF-PQ fits
far more vectors per gigabyte and gives some recall back.

[1:09] And the thing people forget: a vector index is not a database. You
still need filtering, deletes, and consistency, which is why the interesting
products in this space are databases that added vectors rather than vector
libraries that added a server.
