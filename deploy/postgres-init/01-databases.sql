-- Creates the three per-service databases and one login role per database.
-- Runs once, only against a fresh (empty) postgres data volume — the
-- official image's docker-entrypoint-initdb.d convention.
--
-- All three roles share POSTGRES_PASSWORD (the one password install.sh
-- generates); the roles are separated for least-privilege ownership per
-- database, not for secrecy from each other. \getenv pulls the value from
-- the postgres container's own environment (already required by the base
-- image to set the superuser password) into a psql variable so it never
-- needs to be baked into this file.
\getenv pg_password POSTGRES_PASSWORD

CREATE ROLE core LOGIN PASSWORD :'pg_password';
CREATE DATABASE nova_core OWNER core;

CREATE ROLE gateway LOGIN PASSWORD :'pg_password';
CREATE DATABASE nova_gateway OWNER gateway;

CREATE ROLE memory LOGIN PASSWORD :'pg_password';
CREATE DATABASE nova_memory OWNER memory;
