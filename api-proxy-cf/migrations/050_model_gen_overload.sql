-- Migration 047: backing table for the model-generation overload guard
-- (checkModelGenOverload in src/index.js). One row per distinct client IP that
-- has made a POST /v1/chat/completions request inside the current rolling
-- window; the endpoint rejects further generation requests once more than
-- MAX_GEN_IPS distinct IPs are present. window_start is an epoch-second
-- timestamp used to expire rows outside the window.

CREATE TABLE IF NOT EXISTS model_gen_ip_load (
  ip            TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL
);
