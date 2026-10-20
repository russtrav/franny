-- Each edge function instance holds at most one league_reader connection; 10 covers a burst of
-- simultaneous questions from a 12-team league while still capping load on the database.
alter role league_reader connection limit 10;
