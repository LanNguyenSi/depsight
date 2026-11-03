-- Source database for scripts/restore-drill.sh: objects and values whose pg_dump output
-- holds lines a line-based check would take for transaction control or psql commands
-- (the END; of a plpgsql body and of a BEGIN ATOMIC body, COPY lines that start with
-- END;, COMMIT; or an escaped backslash), plus strings that are easy to mis-lex. The drill
-- dumps this database with the real pg_dump and restores it with the real restore.sh.
CREATE TABLE public.t (id integer PRIMARY KEY, v text, "begin" integer);
INSERT INTO public.t VALUES
  (1, 'end;', 1),
  (2, 'commit;', 2),
  (3, 'Grüße, naïve 日本', 3),
  (4, 'it''s (paren', 4),
  (5, E'line1\nEND;\nline3', 5),
  (6, E'tab\tx', 6),
  (7, '\.', 7),
  (8, 'a\b', 8),
  (9, '\q', 9),
  (10, 'C:\path\', 10),
  (11, E'\\x', 11),
  (12, E'cr\rinside', 12);

-- one text column: every value is a whole COPY line of its own
CREATE TABLE public.lines (v text);
INSERT INTO public.lines VALUES
  ('END;'), ('COMMIT;'), ('ROLLBACK;'), ('begin;'), ('\q'), ('\x'), ('\.x'),
  ('\connect other'), ('\! id'), ('BEGIN ATOMIC'), ('-- not a comment'), ('/* not a comment'),
  (E'\r\\q'), ('$$'), ('''');

CREATE FUNCTION public.plf(x integer) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  IF x > 0 THEN
    RETURN 1;
  END IF;
  FOR i IN 1..2 LOOP
    NULL;
  END LOOP;
  RETURN 0;
END;
$$;

CREATE FUNCTION public.atf(x integer) RETURNS integer LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN (x > (1 + (2))) THEN (CASE WHEN x > 5 THEN 2 ELSE 1 END) ELSE 0 END;
END;

CREATE PROCEDURE public.atp(a integer, b integer DEFAULT (1)) LANGUAGE sql
BEGIN ATOMIC
  INSERT INTO public.t VALUES (a + 100, (SELECT 'p' || (b)::text), 0);
  SELECT CASE WHEN a > 0 THEN 1 END;
END;

CREATE FUNCTION public.rx(s text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN s ~ 'ä\s'; END; $$;
CREATE FUNCTION public.enc() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('client_encoding') $$;

CREATE VIEW public.vv AS SELECT id, (v || ')') AS v2 FROM public.t WHERE v <> '(';
COMMENT ON TABLE public.t IS 'comment with ; COMMIT; inside';

CREATE TABLE public."My Table" ("Col A" text DEFAULT 'C:\dir\', b integer);
INSERT INTO public."My Table" VALUES ('x)y(', 1), ('é\x', 2);

CREATE SEQUENCE public.s;
SELECT pg_catalog.setval('public.s', 42);
