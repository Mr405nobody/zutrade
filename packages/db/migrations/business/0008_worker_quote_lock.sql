-- PostgreSQL row locking requires UPDATE privilege on at least one column.
-- Identity-only grants do not permit editing business facts or frozen content.
GRANT UPDATE(id) ON app.opportunities TO zutrade_worker;
