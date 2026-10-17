# @nova/compute

The Nova compute node. It runs on a machine with a local model server (Ollama or a llama.cpp
server), registers with a Hub using a one-time enrollment token, and serves only jobs the Hub
authorizes (FR-126). It never connects to clients.
