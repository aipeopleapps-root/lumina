"""
Database connection helper for Postgres Flexible Server using psycopg2.

Preserves the same Connection/Cursor interface as the RDS Data API shim
it replaces, so call sites (e.g. pi_aurora.py) that already use native
%s-style placeholders need zero changes.
"""

import os
from contextlib import contextmanager

import psycopg2
import psycopg2.pool

_DB_HOST = os.environ.get("DB_HOST", "")
_DB_NAME = os.environ.get("DB_NAME", "platform")
_DB_USER = os.environ.get("DB_USER", "")
_DB_PASSWORD = os.environ.get("DB_PASSWORD", "")

_pool: psycopg2.pool.ThreadedConnectionPool | None = None


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            1, 5,
            host=_DB_HOST,
            dbname=_DB_NAME,
            user=_DB_USER,
            password=_DB_PASSWORD,
            sslmode="require",
        )
    return _pool


class Connection:
    """Thin wrapper around a pooled psycopg2 connection."""

    def __init__(self, pg_conn):
        self._pg_conn = pg_conn

    def cursor(self):
        return Cursor(self._pg_conn.cursor())

    def commit(self):
        self._pg_conn.commit()

    def rollback(self):
        self._pg_conn.rollback()


class Cursor:
    """Thin wrapper around a psycopg2 cursor."""

    def __init__(self, pg_cursor):
        self._pg_cursor = pg_cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._pg_cursor.close()
        return False

    def execute(self, sql, params=None):
        self._pg_cursor.execute(sql, params)

    def fetchone(self):
        return self._pg_cursor.fetchone()

    def fetchall(self):
        return self._pg_cursor.fetchall()


@contextmanager
def get_connection():
    """Get a database connection (context manager) from the pool."""
    pool = _get_pool()
    pg_conn = pool.getconn()
    conn = Connection(pg_conn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(pg_conn)
