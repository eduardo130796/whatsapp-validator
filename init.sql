CREATE TABLE IF NOT EXISTS numbers (
    id SERIAL PRIMARY KEY,
    number VARCHAR(20) UNIQUE,
    valid BOOLEAN,
    status VARCHAR(20) DEFAULT 'pending',
    last_checked TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status ON numbers(status);

