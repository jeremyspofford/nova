-- Migration 011: add source column to tasks if missing (v1 db upgrade path)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
