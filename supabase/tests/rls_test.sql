-- Test delle regole di sicurezza. Eseguito da supabase/tests/run.sh
\set ON_ERROR_STOP on
\set QUIET on

create function pg_temp.expect_error(stmt text, label text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'FALLITO: % — avrebbe dovuto essere rifiutato', label;
exception when others then
  if sqlerrm like 'FALLITO:%' then raise; end if;
  raise notice 'ok  %  (%)', label, sqlerrm;
end $$;
create function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'FALLITO: %', label; end if;
  raise notice 'ok  %', label;
end $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.expect(boolean, text) to public;

-- Utenti: il primo diventa admin
insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a', 'Admin.Uno@campus.unimib.it', '{"full_name":"Anna Admin"}'),
  ('00000000-0000-0000-0000-00000000000b', 'n.cognome@campus.unimib.it', '{"full_name":"Nome Cognome"}'),
  ('00000000-0000-0000-0000-00000000000c', 'intruso@gmail.com', '{"full_name":"Intruso"}');

select pg_temp.expect((select role from profiles where email = 'admin.uno@campus.unimib.it') = 'admin', 'il primo utente è admin');
select pg_temp.expect((select role from profiles where email = 'n.cognome@campus.unimib.it') = 'student', 'il secondo è studente');
select pg_temp.expect(not exists (select 1 from profiles where email = 'intruso@gmail.com'), 'nessun profilo per account esterni');

-- ===== Anonimo =====
set role anon;
select pg_temp.expect_error('select * from courses', 'anonimo non legge i corsi');
reset role;

-- ===== Studente =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);

insert into courses (name, code) values ('Chimica Organica I', 'CHI-101');
select pg_temp.expect((select count(*) from courses) = 1, 'studente crea e vede un corso');
select pg_temp.expect((select created_by from courses limit 1) = auth.uid(), 'created_by impostato dal server');
insert into courses (name, degree, study_year) values ('Chimica Inorganica 1', 'triennale', 1);
select pg_temp.expect_error($q$insert into courses (name, degree, study_year) values ('X', 'magistrale', 3)$q$, 'magistrale ha solo 2 anni');
select pg_temp.expect_error($q$insert into courses (name, degree, study_year) values ('X', 'triennale', null)$q$, 'laurea senza anno rifiutata');
update courses set study_year = 2 where name = 'Chimica Inorganica 1';
select pg_temp.expect((select study_year from courses where name = 'Chimica Inorganica 1') = 1, 'studente NON sposta i corsi');
reset role;
delete from courses where name = 'Chimica Inorganica 1';
set role authenticated;

insert into files (course_id, title, original_name, storage_path, mime, kind, size)
values ((select id from courses limit 1), 'Lezione 1', 'lezione1.pdf', '00000000-0000-0000-0000-00000000000b/a.pdf', 'application/pdf', 'pdf', 1000);
select pg_temp.expect((select count(*) from files) = 1, 'studente carica un file');
select pg_temp.expect_error($q$insert into files (course_id, title, original_name, storage_path, mime, kind, size)
  values ((select id from courses limit 1), 'X', 'x.pdf', '00000000-0000-0000-0000-00000000000a/x.pdf', 'application/pdf', 'pdf', 1)$q$,
  'studente non scrive nella cartella altrui');
select pg_temp.expect_error($q$insert into files (course_id, title, original_name, storage_path, mime, kind, size, uploaded_by)
  values ((select id from courses limit 1), 'X', 'x.pdf', '00000000-0000-0000-0000-00000000000b/y.pdf', 'application/pdf', 'nonvalido', 1, null)$q$,
  'tipo file non valido rifiutato');

delete from files;
select pg_temp.expect((select count(*) from files) = 1, 'studente NON elimina file');
update courses set name = 'Hack';
delete from courses;
select pg_temp.expect((select name from courses limit 1) = 'Chimica Organica I', 'studente NON modifica/elimina corsi');
select pg_temp.expect_error($q$select set_role('00000000-0000-0000-0000-00000000000b', 'admin')$q$, 'studente non si promuove admin');
select pg_temp.expect_error($q$update profiles set role = 'admin'$q$, 'studente non modifica i profili');
select pg_temp.expect((select count(*) from audit_log) = 0, 'studente non legge il registro');
select pg_temp.expect((stats() ->> 'files')::int = 1, 'statistiche visibili');
insert into files (course_id, title, original_name, storage_path, storage, mime, kind, size)
values ((select id from courses limit 1), 'Audio', 'a.mp3', '00000000-0000-0000-0000-00000000000b/b.mp3', 'b2', 'audio/mpeg', 'audio', 5000);
select pg_temp.expect(b2_used_bytes() = 5000, 'spazio B2 conteggiato');
select pg_temp.expect((stats() ->> 'b2_bytes')::int = 5000, 'statistiche B2');
select pg_temp.expect_error($q$insert into files (course_id, title, original_name, storage_path, storage, mime, kind, size)
  values ((select id from courses limit 1), 'X', 'x.pdf', '00000000-0000-0000-0000-00000000000b/z.pdf', 'dropbox', 'application/pdf', 'pdf', 1)$q$,
  'archivio sconosciuto rifiutato');

insert into storage.objects (bucket_id, name) values ('materiali', '00000000-0000-0000-0000-00000000000b/a.pdf');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('materiali', '00000000-0000-0000-0000-00000000000a/z.pdf')$q$,
  'storage: niente upload in cartelle altrui');
delete from storage.objects;
select pg_temp.expect((select count(*) from storage.objects) = 1, 'storage: studente NON elimina');

-- ===== Pulizia automatica dell'archivio B2 =====
reset role;
update app_settings set value = '10000' where key = 'b2_quota_bytes';   -- quota di prova: 10.000 byte
delete from files where storage = 'b2';
insert into files (course_id, title, original_name, storage_path, storage, mime, kind, size) values
  ((select id from courses limit 1), 'Vecchio mai aperto', 'a.pdf', '00000000-0000-0000-0000-00000000000b/ev-a.pdf', 'b2', 'application/pdf', 'pdf', 3000),
  ((select id from courses limit 1), 'Vecchio molto aperto', 'b.pdf', '00000000-0000-0000-0000-00000000000b/ev-b.pdf', 'b2', 'application/pdf', 'pdf', 3000),
  ((select id from courses limit 1), 'Vecchio protetto', 'c.pdf', '00000000-0000-0000-0000-00000000000b/ev-c.pdf', 'b2', 'application/pdf', 'pdf', 1000),
  ((select id from courses limit 1), 'Recente mai aperto', 'd.pdf', '00000000-0000-0000-0000-00000000000b/ev-d.pdf', 'b2', 'application/pdf', 'pdf', 2000),
  ((select id from courses limit 1), 'Vecchio aperto una volta', 'e.pdf', '00000000-0000-0000-0000-00000000000b/ev-e.pdf', 'b2', 'application/pdf', 'pdf', 500);
update files set created_at = now() - interval '60 days' where title like 'Vecchio%';
update files set pinned = true where title = 'Vecchio protetto';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select record_file_open((select id from files where title = 'Vecchio molto aperto'));
select record_file_open((select id from files where title = 'Vecchio molto aperto'));   -- stesso giorno: non conta
select record_file_open((select id from files where title = 'Vecchio aperto una volta'));
select pg_temp.expect((select open_count from files where title = 'Vecchio molto aperto') = 1, 'aperture: max una al giorno per studente');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select record_file_open((select id from files where title = 'Vecchio molto aperto'));
select pg_temp.expect((select open_count from files where title = 'Vecchio molto aperto') = 2, 'aperture di studenti diversi contano');
select pg_temp.expect((select file_title from b2_eviction_preview(1)) = 'Vecchio mai aperto', 'anteprima admin: primo candidato giusto');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect_error('select * from b2_eviction_preview(5)', 'anteprima riservata agli admin');
select pg_temp.expect_error($q$select * from storage_eviction_order('b2')$q$, 'ordine di eliminazione non chiamabile direttamente');
select pg_temp.expect_error($q$select set_pinned((select id from files limit 1), true)$q$, 'solo admin proteggono i file');
-- occupati 9.500 di 10.000: c'è spazio per 400 byte, nessuna eliminazione
select pg_temp.expect((select count(*) from b2_make_room(400)) = 0, 'spazio sufficiente: nessuna eliminazione');
-- servono 2.000 byte: deficit 1.500 → elimina solo "Vecchio mai aperto" (3.000)
select pg_temp.expect((select string_agg(file_title, ',') from b2_make_room(2000)) = 'Vecchio mai aperto', 'elimina solo il meno usato, quanto basta');
select pg_temp.expect(exists (select 1 from files where title = 'Recente mai aperto'), 'file recenti mai eliminati');
-- ora 6.500 usati; servono 8.000 → deficit 4.500: elimina "aperto una volta" (500) e "molto aperto" (3.000)? non basta: 3.500 < 4.500
select pg_temp.expect_error('select * from b2_make_room(8000)', 'spazio insufficiente: nessuna eliminazione parziale');
select pg_temp.expect((select count(*) from files where storage = 'b2') = 4, 'dopo il rifiuto i file sono ancora tutti lì');
-- servono 6.000 → deficit 2.500: elimina "aperto una volta" (500) poi "molto aperto" (3.000)
select pg_temp.expect((select string_agg(file_title, ',' order by bytes) from b2_make_room(6000)) = 'Vecchio aperto una volta,Vecchio molto aperto', 'ordine: meno aperture prima');
select pg_temp.expect(exists (select 1 from files where title = 'Vecchio protetto'), 'file protetti mai eliminati');
reset role;
select pg_temp.expect((select count(*) from audit_log where action = 'file_eliminato_auto') = 3, 'eliminazioni automatiche nel registro');
update app_settings set value = '10200547328' where key = 'b2_quota_bytes';
set role authenticated;

-- ===== Account esterno (gmail) =====
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","email":"intruso@gmail.com"}', false);
select pg_temp.expect((select count(*) from courses) = 0, 'esterno non vede i corsi');
select pg_temp.expect((select count(*) from files) = 0, 'esterno non vede i file');
select pg_temp.expect((select count(*) from storage.objects) = 0, 'esterno non vede l''archivio');
select pg_temp.expect(stats() is null, 'esterno non vede le statistiche');
select pg_temp.expect(b2_used_bytes() is null, 'esterno non vede lo spazio B2');
select pg_temp.expect_error('select * from b2_make_room(100)', 'esterno non può attivare la pulizia');
select pg_temp.expect_error($q$insert into courses (name) values ('Spam')$q$, 'esterno non crea corsi');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('materiali', '00000000-0000-0000-0000-00000000000c/s.pdf')$q$,
  'esterno non carica file');

-- ===== Amministratore =====
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select set_role('00000000-0000-0000-0000-00000000000b', 'admin');
select pg_temp.expect((select role from profiles where email = 'n.cognome@campus.unimib.it') = 'admin', 'admin assegna il ruolo');
select set_role('00000000-0000-0000-0000-00000000000b', 'student');
select pg_temp.expect_error($q$select set_role('00000000-0000-0000-0000-00000000000a', 'student')$q$, 'non si rimuove l''ultimo admin');
update courses set degree = 'magistrale', study_year = 2;
select pg_temp.expect((select degree || study_year from courses limit 1) = 'magistrale2', 'admin sposta il corso');
update courses set description = 'Aggiornato';
select pg_temp.expect((select description from courses limit 1) = 'Aggiornato', 'admin modifica il corso');
delete from storage.objects;
delete from files;
select pg_temp.expect((select count(*) from files) = 0 and (select count(*) from storage.objects) = 0, 'admin elimina file e archivio');
delete from courses;
select pg_temp.expect((select count(*) from courses) = 0, 'admin elimina il corso');
select pg_temp.expect((select count(distinct action) from audit_log where action in ('file_caricato','file_eliminato','corso_eliminato','ruolo_admin_assegnato')) = 4, 'registro attività completo');
reset role;

-- ===== Classifica =====
insert into auth.users values ('00000000-0000-0000-0000-00000000000d', 'l.gatti@campus.unimib.it', '{"full_name":"Lucia Gatti"}');
update profiles set points = 0, upload_count = 0;
insert into courses (name) values ('Corso classifica');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
insert into files (course_id, title, original_name, storage_path, mime, kind, size)
select (select id from courses where name = 'Corso classifica'), 'File ' || g, 'f' || g || '.pdf',
       '00000000-0000-0000-0000-00000000000b/cl-' || g || '.pdf', 'application/pdf', 'pdf', 10
from generate_series(1, 12) g;
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 100, 'punti: +10 a file, max 10 file al giorno');
select pg_temp.expect((select upload_count from profiles where email = 'n.cognome@campus.unimib.it') = 12, 'conteggio caricamenti completo');
select record_file_open((select id from files where title = 'File 1'));
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 100, 'aprire i propri file non dà punti');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000d","email":"l.gatti@campus.unimib.it"}', false);
select record_file_open((select id from files where title = 'File 1'));
select record_file_open((select id from files where title = 'File 1'));
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 105, '+5 a chi ha caricato quando un altro apre il file');
select pg_temp.expect((select points from profiles where email = 'l.gatti@campus.unimib.it') = 1, '+1 a chi apre un file per la prima volta');
reset role;
update file_opens set day = current_date - 3 where user_id = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
select record_file_open((select id from files where title = 'File 1'));   -- un altro giorno: nessun nuovo punto
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 105
  and (select points from profiles where email = 'l.gatti@campus.unimib.it') = 1, 'riaprire lo stesso file non dà più punti');
select pg_temp.expect((select open_count from files where title = 'File 1') = 3, 'ma conta come apertura per la pulizia');
select record_file_open(id) from files where title in ('File 2', 'File 3', 'File 4', 'File 5', 'File 6', 'File 7', 'File 8');
select pg_temp.expect((select points from profiles where email = 'l.gatti@campus.unimib.it') = 6, 'chi apre: massimo 5 punti al giorno');
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 140, 'chi ha caricato: +5 per ogni file aperto, senza limite');
select pg_temp.expect((select user_id from leaderboard() limit 1) = '00000000-0000-0000-0000-00000000000b', 'classifica ordinata per punti');
select pg_temp.expect_error('select banned_reason from profiles', 'studenti non vedono i dati di sospensione');
select pg_temp.expect((select count(*) from profiles) >= 3, 'studenti vedono i profili pubblici');
-- segnalazioni
insert into reports (file_id, reason) values ((select id from files where title = 'File 2'), 'Contenuto inappropriato');
select pg_temp.expect_error($q$insert into reports (file_id, reason) values ((select id from files where title = 'File 2'), 'di nuovo')$q$, 'una sola segnalazione per file a persona');
select pg_temp.expect((select count(*) from reports) = 0, 'studenti non leggono le segnalazioni');
select pg_temp.expect_error($q$select ban_user('00000000-0000-0000-0000-00000000000b', 'x')$q$, 'studenti non sospendono');
select pg_temp.expect_error('select * from admin_users()', 'elenco admin riservato');
-- amministratore
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select pg_temp.expect((select count(*) from reports) = 1, 'admin leggono le segnalazioni');
delete from files where title = 'File 3';
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 130, '-10 se un admin elimina un file');
select pg_temp.expect_error($q$select ban_user('00000000-0000-0000-0000-00000000000a', 'x')$q$, 'non ci si auto-sospende');
select pg_temp.expect_error($q$select ban_user('00000000-0000-0000-0000-00000000000b', '  ')$q$, 'serve un motivo');
select ban_user('00000000-0000-0000-0000-00000000000b', 'Materiale pornografico');
select pg_temp.expect((select banned_reason from admin_users() where email = 'n.cognome@campus.unimib.it') = 'Materiale pornografico', 'sospensione registrata');
select pg_temp.expect(not exists (select 1 from leaderboard() where user_id = '00000000-0000-0000-0000-00000000000b'), 'sospesi esclusi dalla classifica');
-- l'utente sospeso
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect((my_status() ->> 'banned')::boolean and my_status() ->> 'reason' = 'Materiale pornografico', 'il sospeso vede il motivo');
select pg_temp.expect((select count(*) from courses) = 0 and (select count(*) from files) = 0, 'il sospeso non vede più niente');
select pg_temp.expect_error($q$insert into courses (name) values ('Ritorno')$q$, 'il sospeso non crea corsi');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name) values ('materiali', '00000000-0000-0000-0000-00000000000b/z.pdf')$q$, 'il sospeso non carica file');
select pg_temp.expect(stats() is null, 'il sospeso non vede le statistiche');
-- riattivazione ed eliminazione corso (senza penalità)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select unban_user('00000000-0000-0000-0000-00000000000b');
delete from courses where name = 'Corso classifica';
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = 130, 'eliminare un corso non toglie punti');
select pg_temp.expect((select count(*) from reports) = 0, 'segnalazioni rimosse con il file');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect(not (my_status() ->> 'banned')::boolean and (select count(*) from profiles) >= 3, 'riattivato: accesso ripristinato');
reset role;

-- ===== Corsi aperti di recente =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
insert into courses (name) values ('Visita A'), ('Visita B');
select record_course_visit((select id from courses where name = 'Visita A'));
select record_course_visit((select id from courses where name = 'Visita B'));
select record_course_visit((select id from courses where name = 'Visita A'));
select record_course_visit(999999);
select pg_temp.expect((select array_agg(c) from my_recent_courses() c) =
  array[(select id from courses where name = 'Visita A'), (select id from courses where name = 'Visita B')], 'corsi recenti in ordine, senza doppioni');
select pg_temp.expect_error('select * from course_visits', 'tabella visite non leggibile direttamente');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select pg_temp.expect((select count(*) from my_recent_courses()) = 0, 'ognuno vede solo i propri corsi recenti');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","email":"intruso@gmail.com"}', false);
select record_course_visit((select id from courses where name = 'Visita A'));
reset role;
select pg_temp.expect((select count(*) from course_visits) = 2, 'esterni non registrano visite');
select pg_temp.expect((select count(*) from course_visits v join courses c on c.id = v.course_id
  where c.name = 'Visita A') = 1, 'visita aggiornata, non duplicata');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
delete from courses where name in ('Visita A', 'Visita B');
select pg_temp.expect((select count(*) from course_visits) = 0, 'visite rimosse con il corso');

-- ===== Importazione dal vecchio Drive, punti, archivio Cloudflare e robot =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect_error('select new_service_token()', 'solo gli admin generano il codice di servizio');
select pg_temp.expect_error('select * from import_pending', 'studenti non leggono le email del Drive');
select pg_temp.expect_error('select * from import_credits', 'studenti non leggono i crediti del Drive');
select pg_temp.expect_error('select import_status()', 'stato importazione riservato agli admin');
select pg_temp.expect((storage_usage('r2') ->> 'quota')::bigint = 8589934592, 'spazio Cloudflare visibile agli studenti (limite 8 GB)');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select set_config('test.token', new_service_token(), false);
select pg_temp.expect(length(current_setting('test.token')) = 64, 'codice di servizio generato');
select pg_temp.expect((import_status() ->> 'is_owner')::boolean, 'il primo utente è il proprietario');
reset role;
update profiles set role = 'admin' where email = 'n.cognome@campus.unimib.it';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect_error('select new_service_token()', 'un altro amministratore non rigenera il codice');
select pg_temp.expect(not (import_status() ->> 'is_owner')::boolean, 'altro admin: pulsante nascosto');
reset role;
update profiles set role = 'student' where email = 'n.cognome@campus.unimib.it';
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select pg_temp.expect((import_status() ->> 'has_token')::boolean, 'stato: codice presente');
reset role;
select set_config('test.pts', (select points || ',' || upload_count from profiles where email = 'n.cognome@campus.unimib.it'), false);
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.expect_error($q$select import_prepare('sbagliato-sbagliato-sbagliato-sbagliato', 'd1', 'b2', 10)$q$, 'codice sbagliato rifiutato');
select pg_temp.expect(import_prepare(current_setting('test.token'), 'd1', 'b2', 10) = 'ok', 'importazione: controllo preliminare');
select pg_temp.expect(import_prepare(current_setting('test.token'), 'd1', 'r2', 4000 * 1048576::bigint) = 'too_big', 'file troppo grande segnalato');
select import_register(current_setting('test.token'), jsonb_build_object(
  'drive_id', 'd1', 'store', 'b2', 'path', 'import/d1.pdf', 'size', 1000, 'name', 'Appunti.pdf', 'title', 'Appunti',
  'kind', 'pdf', 'mime', 'application/pdf', 'created', '2024-10-05T10:00:00Z', 'owner', 'N.Cognome@campus.unimib.it',
  'course', 'Bioinorganica', 'degree', 'magistrale', 'study_year', 1, 'aa', '2024/2025', 'description', 'Cartella: Appunti'));
select pg_temp.expect(import_prepare(current_setting('test.token'), 'd1', 'b2', 10) = 'exists', 'file già importato riconosciuto');
select set_config('test.d1', import_register(current_setting('test.token'), '{"drive_id":"d1"}')::text, false);
reset role;
select pg_temp.expect(current_setting('test.d1')::bigint = (select id from files where drive_id = 'd1'), 'reimportare non crea doppioni');
select pg_temp.expect((select count(*) from files where drive_id = 'd1') = 1, 'un solo file importato');
select pg_temp.expect((select uploaded_by from files where drive_id = 'd1') = '00000000-0000-0000-0000-00000000000b', 'file attribuito all''autore già iscritto');
select pg_temp.expect((select created_at from files where drive_id = 'd1') = '2024-10-05T10:00:00Z', 'data originale del Drive conservata');
select pg_temp.expect((select imported_at is not null and not needs_processing from files where drive_id = 'd1'), 'data di importazione registrata');
select pg_temp.expect((select degree = 'magistrale' and study_year = 1 and year = '2024/2025' from courses c join files f on f.course_id = c.id where f.drive_id = 'd1'), 'corso creato con laurea, anno e anno accademico');
select pg_temp.expect((select points || ',' || upload_count from profiles where email = 'n.cognome@campus.unimib.it')
  = (split_part(current_setting('test.pts'), ',', 1)::int + 10) || ',' || (split_part(current_setting('test.pts'), ',', 2)::int + 1), '+10 punti e +1 caricamento all''autore iscritto');
select pg_temp.expect(exists (select 1 from audit_log where action = 'file_importato' and details like 'Appunti.pdf%'), 'importazione nel registro');
-- tetto di punti: 25 a persona
update app_settings set value = '25' where key = 'import_points_cap';
set role anon;
select import_register(current_setting('test.token'), jsonb_build_object('drive_id', 'd' || i, 'store', 'b2', 'path', 'import/d' || i || '.pdf',
  'size', 100, 'name', 'F' || i || '.pdf', 'kind', 'pdf', 'mime', 'application/pdf', 'owner', 'n.cognome@campus.unimib.it',
  'course', 'bioinorganica', 'degree', 'magistrale', 'study_year', 1, 'aa', '2024-25', 'created', '2025-03-01T10:00:00Z'))
from generate_series(2, 4) i;
reset role;
select pg_temp.expect((select points from profiles where email = 'n.cognome@campus.unimib.it') = split_part(current_setting('test.pts'), ',', 1)::int + 25, 'tetto di punti per i file importati');
select pg_temp.expect((select count(distinct course_id) from files where drive_id in ('d1', 'd2', 'd3', 'd4')) = 1, 'stesso corso e anno accademico: corso riutilizzato');
update app_settings set value = '0' where key = 'import_points_cap';
-- autore non ancora iscritto; corso con anno non valido → "Da assegnare"; anno accademico diverso → altro corso
set role anon;
select import_register(current_setting('test.token'), jsonb_build_object('drive_id', 'n' || i, 'store', 'r2', 'path', 'import/n' || i || '.m4a',
  'size', 5000, 'name', 'Lezione ' || i || '.m4a', 'kind', 'audio', 'mime', 'audio/mp4', 'owner', 'nuovo.studente@campus.unimib.it',
  'course', 'Bioinorganica', 'degree', 'magistrale', 'study_year', 3, 'aa', '2025/2026', 'created', '2025-10-01T10:00:00Z', 'needs_processing', true))
from generate_series(1, 2) i;
reset role;
select pg_temp.expect((select count(*) from files where drive_id in ('n1', 'n2') and uploaded_by is null) = 2, 'autore non iscritto: file in attesa');
select pg_temp.expect((select count(*) from import_pending where email = 'nuovo.studente@campus.unimib.it') = 2, 'email dell''autore conservata a parte');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000d","email":"l.gatti@campus.unimib.it"}', false);
select record_file_open((select id from files where drive_id = 'n1'));
reset role;
select pg_temp.expect((select view_points from import_credits where email = 'nuovo.studente@campus.unimib.it') = 5, 'aperture dei file di chi non è iscritto: punti messi da parte');
select pg_temp.expect((select degree is null and study_year is null and year = '2025/2026' from courses c join files f on f.course_id = c.id where f.drive_id = 'n1'), 'anno non valido: corso da assegnare');
select pg_temp.expect((select count(distinct course_id) from files where drive_id in ('d1', 'n1')) = 2, 'anno accademico diverso: corso separato');
select pg_temp.expect((select needs_processing and storage = 'r2' from files where drive_id = 'n1'), 'registrazione su Cloudflare da comprimere');
set role anon;
select pg_temp.expect(import_set_author(current_setting('test.token'), 'n1', ' Nuovo Studente ') = 1, 'nome dell''autore del Drive registrato');
select pg_temp.expect_error($q$select import_set_author('sbagliato-sbagliato-sbagliato-sbagliato', 'n1', 'X')$q$, 'nome autore: codice richiesto');
reset role;
select pg_temp.expect((select author_name = 'Nuovo Studente' and uploaded_by is null from files where drive_id = 'n1'), 'nome visibile anche prima del login, senza account');

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select set_config('test.rank', (select count(*) from leaderboard())::text, false);
reset role;
select pg_temp.expect((select points from import_credits where email = 'nuovo.studente@campus.unimib.it') = 20
  and current_setting('test.rank')::int = (select count(*) from profiles where banned_at is null), 'chi non ha fatto il login non è in classifica (punti in attesa)');
insert into auth.users values ('00000000-0000-0000-0000-0000000000ee', 'Nuovo.Studente@campus.unimib.it', '{"full_name":"Nuovo Studente"}');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect((select points from leaderboard() where name = 'Nuovo Studente') = 25, 'dopo il login compare in classifica con i punti del Drive (anche delle aperture)');
reset role;
select pg_temp.expect((select points = 25 and upload_count = 2 from profiles where email = 'nuovo.studente@campus.unimib.it'), 'primo accesso: punti del Drive accreditati');
select pg_temp.expect((select view_points from import_credits where email = 'nuovo.studente@campus.unimib.it') = 0, 'punti delle aperture accreditati una volta sola');
select pg_temp.expect((select count(*) from files where uploaded_by = '00000000-0000-0000-0000-0000000000ee') = 2, 'primo accesso: file del Drive attribuiti');
select pg_temp.expect(not exists (select 1 from import_pending where email = 'nuovo.studente@campus.unimib.it'), 'primo accesso: attesa chiusa');
set role anon;
select import_register(current_setting('test.token'), jsonb_build_object('drive_id', 'n3', 'store', 'b2', 'path', 'import/n3.pdf',
  'size', 10, 'name', 'Dopo.pdf', 'kind', 'pdf', 'mime', 'application/pdf', 'owner', 'nuovo.studente@campus.unimib.it', 'course', 'Fotochimica'));
reset role;
select pg_temp.expect((select points from profiles where email = 'nuovo.studente@campus.unimib.it') = 35, 'dopo l''iscrizione i punti arrivano subito');
select pg_temp.expect((select value from app_settings where key = 'import_points_cap') = '0', 'nessun tetto ai punti dei file importati');
-- Cloudflare pieno: l'importazione aspetta la compressione
update app_settings set value = '12000' where key = 'r2_quota_bytes';
set role anon;
select pg_temp.expect(import_prepare(current_setting('test.token'), 'zz', 'r2', 5000) = 'full', 'archivio pieno: importazione in attesa');
reset role;
update app_settings set value = '8589934592' where key = 'r2_quota_bytes';
-- uno studente non può fingere un'importazione
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
insert into files (course_id, title, original_name, storage_path, storage, mime, kind, size, imported_at, drive_id, needs_processing, author_name)
values ((select id from courses where name = 'Fotochimica'), 'Finto', 'f.m4a', '00000000-0000-0000-0000-00000000000b/f.m4a', 'r2', 'audio/mp4', 'audio', 10, now(), 'finto', false, 'Falso Autore');
reset role;
select pg_temp.expect((select imported_at is null and drive_id is null and needs_processing from files where title = 'Finto'), 'studente: niente date o id di importazione, registrazione da comprimere');
select pg_temp.expect((select author_name is null from files where title = 'Finto'), 'studente: non può inventare un nome d''autore');
-- Pulizia: file importati protetti per 6 mesi; registrazioni e documenti con finestre diverse; archivi separati
update files set created_at = now() - interval '800 days' where drive_id in ('d1', 'n1') or title = 'Finto';
select pg_temp.expect(not exists (select 1 from storage_eviction_order('b2') where file_id = (select id from files where drive_id = 'd1')), 'file importato da poco: protetto');
update files set imported_at = now() - interval '200 days' where drive_id in ('d1', 'n1');
select pg_temp.expect(exists (select 1 from storage_eviction_order('b2') where file_id = (select id from files where drive_id = 'd1')), 'dopo 6 mesi il file importato è eliminabile');
select pg_temp.expect(not exists (select 1 from storage_eviction_order('b2') where file_id = (select id from files where drive_id = 'n1')), 'ogni archivio libera spazio solo tra i suoi file');
insert into file_opens (file_id, user_id, day) select id, '00000000-0000-0000-0000-00000000000a', current_date - 400 from files where drive_id in ('d1', 'n1');
select pg_temp.expect((select opens from storage_eviction_order('b2') where file_id = (select id from files where drive_id = 'd1')) = 1, 'documenti: aperture contate per un anno e mezzo');
select pg_temp.expect((select opens from storage_eviction_order('r2') where file_id = (select id from files where drive_id = 'n1')) = 1, 'registrazioni: aperture contate per un anno (quella di 400 giorni fa no)');
-- Robot
set role anon;
select pg_temp.expect_error($q$select * from robot_pending('sbagliato-sbagliato-sbagliato-sbagliato')$q$, 'robot: codice sbagliato rifiutato');
select pg_temp.expect((select count(*) from robot_pending(current_setting('test.token'))) = 3, 'robot: registrazioni da comprimere');
select pg_temp.expect(robot_done(current_setting('test.token'), (select id from robot_pending(current_setting('test.token')) where original_name = 'Lezione 1.m4a'),
  'import/n1-c.m4a', '', 1200, 'audio/mp4', 'Lezione 1.m4a'), 'robot: file compresso registrato');
select set_config('test.zip', robot_add(current_setting('test.token'), (select id from robot_pending(current_setting('test.token')) where original_name = 'Lezione 2.m4a'),
  '{"path": "import/z1.mp4", "size": 300, "name": "Lezione A.mp4", "title": "Lezione A", "kind": "video", "mime": "video/mp4"}')::text, false);
select pg_temp.expect(robot_add(current_setting('test.token'), (select id from robot_pending(current_setting('test.token')) where original_name = 'Lezione 2.m4a'),
  '{"path": "import/z1-bis.mp4", "size": 300, "name": "Lezione A.mp4", "title": "Lezione A", "kind": "video", "mime": "video/mp4"}') = current_setting('test.zip')::bigint,
  'robot: lezione già estratta non duplicata (ripresa dopo interruzione)');
select pg_temp.expect((select array_agg(x) from robot_extracted(current_setting('test.token'), (select id from robot_pending(current_setting('test.token')) where original_name = 'Lezione 2.m4a')) x)
  = array['Lezione A.mp4'], 'robot: elenco delle lezioni già estratte');
select robot_failed(current_setting('test.token'), (select id from robot_pending(current_setting('test.token')) where original_name = 'f.m4a'), 'formato non valido');
reset role;
select pg_temp.expect((select size = 1200 and storage_path = 'import/n1-c.m4a' and not needs_processing from files where drive_id = 'n1'), 'robot: dimensione e percorso aggiornati');
select pg_temp.expect((select course_id = (select course_id from files where drive_id = 'n2') and uploaded_by = '00000000-0000-0000-0000-0000000000ee'
  and not needs_processing from files where id = current_setting('test.zip')::bigint), 'robot: lezione estratta nello stesso corso e con lo stesso autore');
select set_config('test.pts', (select points || ',' || upload_count from profiles where email = 'nuovo.studente@campus.unimib.it'), false);
select set_config('test.n2', (select id from files where drive_id = 'n2')::text, false);
set role anon;
select robot_remove(current_setting('test.token'), current_setting('test.n2')::bigint);
reset role;
select pg_temp.expect(not exists (select 1 from files where drive_id = 'n2'), 'robot: archivio ZIP rimosso');
select pg_temp.expect((select points || ',' || upload_count from profiles where email = 'nuovo.studente@campus.unimib.it') = current_setting('test.pts'), 'robot: nessun punto tolto');
select pg_temp.expect((select processing_error from files where title = 'Finto') = 'formato non valido', 'robot: errore registrato');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
select pg_temp.expect((import_status() ->> 'imported')::int = 7 and (import_status() ->> 'processing')::int = 0, 'stato importazione per gli admin');
select set_config('test.old', current_setting('test.token'), false);
select set_config('test.token', new_service_token(), false);
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.expect_error($q$select * from robot_pending(current_setting('test.old'))$q$, 'nuovo codice: il vecchio non funziona più');
reset role;
delete from files where imported_at is not null or title = 'Finto';
delete from courses where description like 'Materiali importati%';

-- ===== Ricalcolo dei punti con le nuove regole (aperture fatte prima dell'aggiornamento) =====
reset role;
insert into courses (name) values ('Corso ricalcolo');
select set_config('app.importing', '1', false);
insert into files (course_id, title, original_name, storage_path, mime, kind, size, uploaded_by)
select (select id from courses where name = 'Corso ricalcolo'), 'R' || g, 'r' || g || '.pdf', 'x/r' || g || '.pdf', 'application/pdf', 'pdf', 1,
       '00000000-0000-0000-0000-00000000000a' from generate_series(1, 7) g;
select set_config('app.importing', '', false);
-- vecchie regole: Lucia apre R1 tre giorni diversi (+3 all'autore) e R1..R7 lo stesso giorno (+6); Nome apre R1 (+1)
insert into file_opens (file_id, user_id, day) select id, '00000000-0000-0000-0000-00000000000d', current_date - 40 from files where title like 'R_';
insert into file_opens (file_id, user_id, day) select id, '00000000-0000-0000-0000-00000000000d', current_date - d from files, generate_series(41, 42) d where title = 'R1';
insert into file_opens (file_id, user_id, day) select id, '00000000-0000-0000-0000-00000000000b', current_date - 40 from files where title = 'R1';
select set_config('test.adm', (select points from profiles where email = 'admin.uno@campus.unimib.it')::text, false);
select set_config('test.luc', (select points from profiles where email = 'l.gatti@campus.unimib.it')::text, false);
-- il ricalcolo riguarda tutte le aperture: lo rifaccio da zero per controllare solo questi file
delete from file_opens where file_id not in (select id from files where title like 'R_');
update profiles set points = points + 10 where email = 'admin.uno@campus.unimib.it';   -- 7 + 2 + 1 aperture con le vecchie regole
delete from app_settings where key = 'points_v2';
set client_min_messages = warning;
\ir ../setup.sql
set client_min_messages = notice;
select pg_temp.expect((select points from profiles where email = 'admin.uno@campus.unimib.it') = current_setting('test.adm')::int + 40,
  'ricalcolo: +5 per ogni studente diverso per file (8 coppie), al posto di +1 per apertura');
select pg_temp.expect((select points from profiles where email = 'l.gatti@campus.unimib.it') = current_setting('test.luc')::int + 6,
  'ricalcolo: chi ha aperto riceve +1 per file nuovo, max 5 al giorno (1 un giorno, 5 su 6 un altro)');
select pg_temp.expect((select count(*) from app_settings where key = 'points_v2') = 1, 'ricalcolo eseguito una volta sola');
delete from courses where name = 'Corso ricalcolo';

-- ===== Tour di benvenuto =====
insert into auth.users values ('00000000-0000-0000-0000-0000000000f1', 'nuova.matricola@campus.unimib.it', '{"full_name":"Nuova Matricola"}');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","email":"nuova.matricola@campus.unimib.it"}', false);
select pg_temp.expect(tour_pending(), 'nuovo account: tour da mostrare');
select tour_done();
select pg_temp.expect(not tour_pending(), 'tour visto: non ricompare (anche su altri dispositivi)');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","email":"intruso@gmail.com"}', false);
select pg_temp.expect(not tour_pending(), 'esterni: niente tour');
reset role;

-- ===== Docenti =====
select pg_temp.expect((select count(*) from professors) = 62, 'elenco docenti caricato una sola volta (62)');
select pg_temp.expect((select courses from professors where last_name = 'Di Credico') like 'Chimica generale%', 'dati docenti corretti');
set role anon;
select pg_temp.expect_error('select * from professors', 'anonimo non vede i docenti');
reset role;

-- ===== Pagina Rappresentanti =====
set role anon;
select pg_temp.expect_error('select * from representatives', 'anonimo non vede i rappresentanti');
reset role;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","email":"n.cognome@campus.unimib.it"}', false);
select pg_temp.expect((select count(*) from info_links) >= 10, 'studenti vedono i link utili precaricati');
select pg_temp.expect_error($q$insert into representatives (name) values ('Intruso')$q$, 'studenti non aggiungono rappresentanti');
select pg_temp.expect((select count(*) from professors) = 62, 'studenti vedono i docenti');
update professors set email = 'hack@x.it';
select pg_temp.expect(not exists (select 1 from professors where email = 'hack@x.it'), 'studenti non modificano i docenti');
update info_links set label = 'hack';
select pg_temp.expect(not exists (select 1 from info_links where label = 'hack'), 'studenti non modificano i link');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","email":"intruso@gmail.com"}', false);
select pg_temp.expect((select count(*) from info_links) = 0, 'esterni non vedono la pagina');
select pg_temp.expect((select count(*) from professors) = 0, 'esterni non vedono i docenti');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","email":"admin.uno@campus.unimib.it"}', false);
insert into representatives (name, role_label, email, sort_order) values ('Rappresentante Prova', '3° anno Triennale', 'r.prova@campus.unimib.it', 1);
select pg_temp.expect((select count(*) from representatives) = 1, 'admin aggiungono rappresentanti');
select pg_temp.expect_error($q$insert into info_links (section, label, url) values ('siti', 'X', 'javascript:alert(1)')$q$, 'link non https rifiutati');
reset role;

\warn 'TUTTI I TEST SUPERATI'
