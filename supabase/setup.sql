-- =============================================================================
--  e-Learning Bicocca — configurazione del database Supabase
--
--  COME USARLO: Supabase → SQL Editor → New query → incolla TUTTO questo file
--  → premi "Run". Si può rieseguire senza problemi.
--
--  Regole applicate dal database (non aggirabili dal browser):
--   • solo gli account @campus.unimib.it vedono e caricano materiali;
--   • tutti gli studenti possono creare corsi e caricare file;
--   • solo gli amministratori possono modificare/eliminare corsi ed eliminare file;
--   • il PRIMO utente che accede diventa automaticamente amministratore.
-- =============================================================================

-- Dominio ammesso -------------------------------------------------------------
create or replace function public.allowed_domain()
returns text language sql immutable as $$ select 'campus.unimib.it' $$;

-- Tabelle -------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  name        text not null,
  role        text not null default 'student' check (role in ('student', 'admin')),
  created_at  timestamptz not null default now()
);

create table if not exists public.courses (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 1 and 140),
  code        text check (char_length(code) <= 30),
  teacher     text check (char_length(teacher) <= 120),
  year        text check (char_length(year) <= 30),
  description text check (char_length(description) <= 2000),
  color       int  not null default 0,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.files (
  id            bigint generated always as identity primary key,
  course_id     bigint not null references public.courses(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 200),
  description   text check (char_length(description) <= 2000),
  original_name text not null check (char_length(original_name) <= 255),
  storage_path  text not null unique,
  mime          text not null,
  kind          text not null check (kind in ('pdf', 'image', 'audio', 'video', 'document', 'other')),
  size          bigint not null check (size >= 0),
  uploaded_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists files_course_idx on public.files(course_id);

-- Corso di laurea e anno di corso (triennale: 1°–3°, magistrale: 1°–2°; vuoti = da assegnare)
alter table public.courses add column if not exists degree text;
alter table public.courses add column if not exists study_year smallint;
do $$ begin
  alter table public.courses add constraint courses_degree_year_check check (
    case when degree is null then study_year is null
         when degree = 'triennale' then coalesce(study_year between 1 and 3, false)
         when degree = 'magistrale' then coalesce(study_year between 1 and 2, false)
         else false end);
exception when duplicate_object then null;
end $$;
create index if not exists files_uploader_idx on public.files(uploaded_by);

-- Dove si trova il file: archivio Supabase oppure Backblaze B2 (aggiunto in seguito)
alter table public.files add column if not exists storage text not null default 'supabase';
-- 'b2' = Backblaze (documenti), 'r2' = Cloudflare R2 (registrazioni audio e video)
alter table public.files drop constraint if exists files_storage_check;
alter table public.files add constraint files_storage_check check (storage in ('supabase', 'b2', 'r2'));

-- Statistiche di utilizzo per la pulizia automatica dell'archivio B2
alter table public.files add column if not exists storage_version text;
alter table public.files add column if not exists open_count integer not null default 0;
alter table public.files add column if not exists last_opened_at timestamptz;
alter table public.files add column if not exists pinned boolean not null default false;

-- Importazione dal vecchio Google Drive e compressione automatica delle registrazioni
alter table public.files add column if not exists drive_id text;           -- file d'origine su Drive (niente doppioni)
alter table public.files add column if not exists imported_at timestamptz; -- data dell'importazione
alter table public.files add column if not exists needs_processing boolean not null default false; -- da comprimere (robot)
alter table public.files add column if not exists processing_error text;
alter table public.files add column if not exists author_name text;        -- nome dell'autore sul Drive (finché non si iscrive)
alter table public.files add column if not exists folder text;             -- cartella dentro il corso (es. "Esercizi")
alter table public.files add column if not exists vote_count integer not null default 0;  -- voti "Utile 👍"
do $$ begin
  alter table public.files add constraint files_folder_len check (char_length(folder) <= 120);
exception when duplicate_object then null;
end $$;
-- Cartelle dei file importati: ricavate dalla descrizione ("… · Cartella: Esercizi")
update public.files set folder = left(trim(substring(description from 'Cartella: (.+)$')), 120)
where folder is null and description like '%Cartella: %';

-- Corsi preferiti ⭐ di ciascuno studente
create table if not exists public.course_favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  course_id  bigint not null references public.courses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

-- Voti "Utile 👍" (uno per studente e file)
create table if not exists public.file_votes (
  file_id    bigint not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (file_id, user_id)
);
create unique index if not exists files_drive_id_idx on public.files(drive_id);
create index if not exists files_processing_idx on public.files(id) where needs_processing;

-- Autori del Drive non ancora iscritti: i loro file e punti vengono assegnati al primo accesso.
-- Le email restano qui, non leggibili dagli studenti.
create table if not exists public.import_pending (
  file_id bigint primary key references public.files(id) on delete cascade,
  email   text not null
);
create index if not exists import_pending_email_idx on public.import_pending(email);
create table if not exists public.import_credits (
  email  text primary key,
  files  integer not null default 0,
  points integer not null default 0,   -- punti spettanti per i file importati (con tetto)
  paid   integer not null default 0    -- punti già accreditati a un profilo
);
-- punti per le aperture dei file di autori non ancora iscritti (accreditati al primo accesso)
alter table public.import_credits add column if not exists view_points integer not null default 0;

-- Aperture: ogni studente conta al massimo una volta al giorno per file
create table if not exists public.file_opens (
  file_id bigint not null references public.files(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null default current_date,
  primary key (file_id, user_id, day)
);
create index if not exists file_opens_day_idx on public.file_opens(file_id, day);
-- punti dati a chi ha aperto (1 se era la prima volta per quel file, entro il limite giornaliero)
alter table public.file_opens add column if not exists reader_points smallint not null default 0;
create index if not exists file_opens_user_day_idx on public.file_opens(user_id, day);

-- Corsi aperti di recente da ciascuno studente (per la dashboard, uguale su ogni dispositivo)
create table if not exists public.course_visits (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  course_id  bigint not null references public.courses(id) on delete cascade,
  visited_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

-- Impostazioni modificabili dagli amministratori (via SQL Editor)
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
insert into public.app_settings (key, value) values
  ('b2_quota_bytes', '10200547328'),   -- 9,5 GB: sotto i 10 GB gratuiti di Backblaze
  ('evict_grace_days', '14'),          -- i file più recenti di così non vengono mai eliminati
  ('evict_window_days', '365'),        -- registrazioni audio/video: aperture contate nell'ultimo anno
  ('evict_window_days_docs', '548'),   -- documenti (PDF, appunti, foto…): aperture contate nell'ultimo anno e mezzo
  ('r2_quota_bytes', '8589934592'),    -- 8 GB: margine di 2 GB sotto i 10 GB gratuiti di Cloudflare R2 (nessun costo
                                       --   anche quando il robot scompatta uno ZIP e per un momento esistono entrambi)
  ('import_grace_days', '183'),        -- i file importati dal Drive sono protetti per 6 mesi
  ('import_points_per_file', '10'),    -- punti per ogni file importato…
  ('import_points_cap', '0'),          -- …fino a un massimo per persona (0 = nessun tetto)
  ('import_max_mb', '3000'),           -- dimensione massima di un file importato (gli ZIP vengono poi scompattati)
  ('points_per_view', '5'),            -- a chi ha caricato, quando un altro studente apre il file (una volta per persona)
  ('points_per_read', '1'),            -- a chi apre un file per la prima volta…
  ('read_points_daily_cap', '5'),      -- …fino a questo massimo al giorno
  ('points_per_vote', '3')             -- a chi ha caricato, per ogni voto "Utile 👍" ricevuto
on conflict (key) do nothing;
-- Aggiornamento: nessun tetto ai punti dei file importati (prima 300)
update public.app_settings set value = '0' where key = 'import_points_cap' and value = '300';
-- Aggiornamento: Cloudflare da 9,5 a 8 GB (solo se non è stato cambiato a mano)
update public.app_settings set value = '8589934592' where key = 'r2_quota_bytes' and value = '10200547328';
-- Aggiornamento: il vecchio valore predefinito era 6 mesi
update public.app_settings set value = '365' where key = 'evict_window_days' and value = '180';

-- Classifica (punti) e moderazione (sospensioni, segnalazioni)
alter table public.profiles add column if not exists points integer not null default 0;
alter table public.profiles add column if not exists upload_count integer not null default 0;
alter table public.profiles add column if not exists banned_at timestamptz;
alter table public.profiles add column if not exists banned_reason text;
alter table public.profiles add column if not exists banned_by uuid references public.profiles(id) on delete set null;
-- Tour di benvenuto: mostrato una volta per account, al primo accesso (anche cambiando dispositivo)
alter table public.profiles add column if not exists onboarded_at timestamptz;
-- Ultima visita (per i badge "Nuovo"): seen_at = ora, prev_seen_at = visita precedente
alter table public.profiles add column if not exists seen_at timestamptz;
alter table public.profiles add column if not exists prev_seen_at timestamptz;

-- Pagina "Rappresentanti": contatti e link utili, modificabili dagli admin.
-- I contatti personali NON sono nel codice pubblico: stanno solo qui, visibili agli studenti loggati.
create table if not exists public.representatives (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 120),
  role_label text check (char_length(role_label) <= 120),      -- es. "3° anno Triennale"
  email      text check (char_length(email) <= 200),
  phone      text check (char_length(phone) <= 40),
  sort_order integer not null default 0
);

-- Docenti del corso (pagina "Professori"); i dati iniziali sono in supabase/professori.sql
create table if not exists public.professors (
  id             bigint generated always as identity primary key,
  last_name      text not null check (char_length(last_name) between 1 and 80),
  first_name     text not null check (char_length(first_name) between 1 and 80),
  email          text check (char_length(email) <= 200),
  department     text check (char_length(department) <= 120),
  research_group text check (char_length(research_group) <= 300),
  research_area  text check (char_length(research_area) <= 500),
  positions      text check (char_length(positions) <= 1000),   -- un ruolo per riga
  courses        text check (char_length(courses) <= 3000),     -- un corso per riga
  education      text check (char_length(education) <= 200)
);

create table if not exists public.info_links (
  id         bigint generated always as identity primary key,
  section    text not null check (section in ('siti', 'app', 'matricole', 'sicurezza', 'esami', 'rappresentanza')),
  label      text not null check (char_length(label) between 1 and 200),
  detail     text check (char_length(detail) <= 300),
  url        text check (url is null or url ~ '^https://'),
  sort_order integer not null default 0
);

create table if not exists public.reports (
  id         bigint generated always as identity primary key,
  file_id    bigint not null references public.files(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  reason     text not null check (char_length(reason) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (file_id, user_id)
);

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  action     text not null,
  details    text,
  created_at timestamptz not null default now()
);

-- Funzioni di controllo -----------------------------------------------------------
-- L'email arriva dal token firmato di Supabase Auth: l'utente non può modificarla
-- senza confermare il nuovo indirizzo.
-- Account campus e non sospeso
create or replace function public.is_campus()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(lower(auth.jwt() ->> 'email') like '%@' || public.allowed_domain(), false)
     and not exists (select 1 from profiles where id = auth.uid() and banned_at is not null)
$$;

-- Stato del proprio account (per mostrare la pagina "Account sospeso")
create or replace function public.my_status()
returns json language sql stable security definer set search_path = public as $$
  select case when lower(auth.jwt() ->> 'email') like '%@' || public.allowed_domain() then (
    select json_build_object('exists', true, 'banned', banned_at is not null, 'reason', banned_reason, 'banned_at', banned_at)
    from profiles where id = auth.uid()
  ) end
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_campus() and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  )
$$;

-- Profilo creato automaticamente al primo accesso -----------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(new.email);
  v_name  text := coalesce(
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    split_part(v_email, '@', 1));
begin
  if v_email like '%@' || public.allowed_domain() then
    insert into public.profiles (id, email, name, role)
    values (
      new.id, v_email, left(v_name, 120),
      case when exists (select 1 from public.profiles where role = 'admin') then 'student' else 'admin' end
    )
    on conflict (id) do nothing;
    insert into public.audit_log (user_id, action) values (new.id, 'primo_accesso');
    -- File caricati in passato sul vecchio Drive: diventano suoi, con i relativi punti
    if exists (select 1 from public.import_pending where email = v_email) then
      update public.files set uploaded_by = new.id
      where id in (select file_id from public.import_pending where email = v_email) and uploaded_by is null;
      update public.profiles p set
        upload_count = p.upload_count + (select count(*) from public.import_pending where email = v_email),
        points = p.points + coalesce((select c.points - c.paid + c.view_points from public.import_credits c where c.email = v_email), 0)
      where p.id = new.id;
      update public.import_credits set paid = points, view_points = 0 where email = v_email;
      delete from public.import_pending where email = v_email;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Colore del corso assegnato in automatico ------------------------------------------
create or replace function public.course_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.color := (select count(*) from public.courses) % 8;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists course_defaults on public.courses;
create trigger course_defaults before insert on public.courses
  for each row execute function public.course_defaults();

create or replace function public.file_defaults()
returns trigger language plpgsql as $$
begin
  -- l'importazione dal Drive (funzioni riservate qui sotto) imposta autore e data originali
  if coalesce(current_setting('app.importing', true), '') <> '1' then
    new.uploaded_by := auth.uid();
    new.created_at := now();
    new.imported_at := null;
    new.drive_id := null;
    -- le registrazioni su Cloudflare vengono compresse dal robot
    new.needs_processing := new.storage = 'r2' and new.kind in ('audio', 'video');
    new.processing_error := null;
    new.author_name := null;
    -- statistiche gestite solo dal sito, non impostabili da chi carica
    new.open_count := 0;
    new.vote_count := 0;
    new.last_opened_at := null;
    new.pinned := false;
  end if;
  return new;
end $$;
drop trigger if exists file_defaults on public.files;
create trigger file_defaults before insert on public.files
  for each row execute function public.file_defaults();

-- Registro attività automatico -----------------------------------------------------------
create or replace function public.log_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'files' then
    if tg_op = 'INSERT' then
      if coalesce(current_setting('app.importing', true), '') = '1' then
        if coalesce(current_setting('app.robot', true), '') <> '1' then
          insert into audit_log (user_id, action, details)
          values (null, 'file_importato', new.original_name || ' → ' || (select name from courses where id = new.course_id));
        end if;
      else
        insert into audit_log (user_id, action, details)
        values (auth.uid(), 'file_caricato', new.original_name || ' → ' || (select name from courses where id = new.course_id));
      end if;
    elsif tg_op = 'DELETE' then
      if current_setting('app.robot', true) = '1' then
        insert into audit_log (user_id, action, details) values (null, 'archivio_scompattato', old.original_name);
      elsif current_setting('app.auto_evict', true) = '1' then
        insert into audit_log (user_id, action, details)
        values (null, 'file_eliminato_auto', old.original_name || ' (' || old.open_count || ' aperture)');
      else
        insert into audit_log (user_id, action, details)
        values (auth.uid(), 'file_eliminato', old.original_name);
      end if;
    end if;
  elsif tg_table_name = 'courses' then
    if tg_op = 'INSERT' then
      insert into audit_log (user_id, action, details) values (auth.uid(), 'corso_creato', new.name);
    elsif tg_op = 'UPDATE' then
      insert into audit_log (user_id, action, details) values (auth.uid(), 'corso_modificato', new.name);
    elsif tg_op = 'DELETE' then
      insert into audit_log (user_id, action, details) values (auth.uid(), 'corso_eliminato', old.name);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists log_files on public.files;
create trigger log_files after insert or delete on public.files
  for each row execute function public.log_change();
drop trigger if exists log_courses on public.courses;
create trigger log_courses after insert or update or delete on public.courses
  for each row execute function public.log_change();

-- Assegnare / revocare il ruolo di amministratore ---------------------------------------
create or replace function public.set_role(target uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if not public.is_admin() then
    raise exception 'Operazione riservata agli amministratori';
  end if;
  if new_role not in ('student', 'admin') then
    raise exception 'Ruolo non valido';
  end if;
  if new_role = 'student'
     and (select role from profiles where id = target) = 'admin'
     and (select count(*) from profiles where role = 'admin') <= 1 then
    raise exception 'Deve rimanere almeno un amministratore';
  end if;
  update profiles set role = new_role where id = target returning email into v_email;
  if v_email is null then raise exception 'Utente non trovato'; end if;
  insert into audit_log (user_id, action, details)
  values (auth.uid(), case when new_role = 'admin' then 'ruolo_admin_assegnato' else 'ruolo_admin_revocato' end, v_email);
end $$;

-- Statistiche (conteggi e spazio occupato) ------------------------------------------
create or replace function public.stats()
returns json language sql stable security definer set search_path = public as $$
  select case when public.is_campus() then json_build_object(
    'courses', (select count(*) from courses),
    'files',   (select count(*) from files),
    'users',   (select count(*) from profiles),
    'bytes',   (select coalesce(sum(size), 0) from files),
    'b2_bytes', (select coalesce(sum(size), 0) from files where storage = 'b2'),
    'r2_bytes', (select coalesce(sum(size), 0) from files where storage = 'r2')
  ) end
$$;

-- Spazio usato su Backblaze B2 (per non superare il limite gratuito)
create or replace function public.b2_used_bytes()
returns bigint language sql stable security definer set search_path = public as $$
  select case when public.is_campus() then (select coalesce(sum(size), 0) from files where storage = 'b2') end
$$;

create or replace function public.setting_int(k text, fallback bigint)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce((select value::bigint from app_settings where key = k), fallback)
$$;

create or replace function public.b2_quota_bytes()
returns bigint language sql stable security definer set search_path = public as $$
  select case when public.is_campus() then public.setting_int('b2_quota_bytes', 10200547328) end
$$;

-- Spazio di ciascun archivio ('b2' Backblaze, 'r2' Cloudflare): uso interno
create or replace function public.storage_used(st text)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(size), 0)::bigint from files where storage = st
$$;
create or replace function public.storage_quota(st text)
returns bigint language sql stable security definer set search_path = public as $$
  select public.setting_int(st || '_quota_bytes', case when st = 'r2' then 8589934592 else 10200547328 end)
$$;
revoke execute on function public.storage_used(text), public.storage_quota(text) from public, anon, authenticated;

-- Spazio usato e limite, per gli studenti collegati
create or replace function public.storage_usage(st text)
returns json language sql stable security definer set search_path = public as $$
  select case when public.is_campus() and st in ('b2', 'r2')
    then json_build_object('used', public.storage_used(st), 'quota', public.storage_quota(st)) end
$$;

-- Ricorda che lo studente ha aperto un corso (ne tiene al massimo 12)
create or replace function public.record_course_visit(cid bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_campus() or not exists (select 1 from courses where id = cid) then return; end if;
  insert into course_visits (user_id, course_id) values (auth.uid(), cid)
  on conflict (user_id, course_id) do update set visited_at = now();
  delete from course_visits v where v.user_id = auth.uid() and v.course_id not in (
    select course_id from course_visits where user_id = auth.uid() order by visited_at desc limit 12);
end;
$$;

-- Corsi aperti di recente dallo studente collegato, dal più recente
create or replace function public.my_recent_courses()
returns setof bigint language sql stable security definer set search_path = public as $$
  select course_id from course_visits
  where user_id = auth.uid() and public.is_campus()
  order by visited_at desc limit 12;
$$;

-- Registra un'apertura (vista o download) di un file.
-- Aperture: max una al giorno per studente (servono alla pulizia automatica).
-- Punti, solo la PRIMA volta che uno studente apre quel file (mai per i propri file):
--   +5 a chi l'ha caricato (o messi da parte, se è un autore del Drive non ancora iscritto)
--   +1 a chi lo apre, fino a 5 punti al giorno
create or replace function public.record_file_open(fid bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_first  boolean;
  v_reader int := 0;
  v_view   int := public.setting_int('points_per_view', 5);
  v_email  text;
begin
  if not public.is_campus() then return; end if;
  select uploaded_by into v_owner from files where id = fid;
  if not found then return; end if;
  v_first := not exists (select 1 from file_opens where file_id = fid and user_id = v_uid)
             and v_owner is distinct from v_uid;
  if v_first and (select coalesce(sum(reader_points), 0) from file_opens where user_id = v_uid and day = current_date)
                 < public.setting_int('read_points_daily_cap', 5) then
    v_reader := public.setting_int('points_per_read', 1);
  end if;
  insert into file_opens (file_id, user_id, day, reader_points) values (fid, v_uid, current_date, v_reader)
  on conflict do nothing;
  if found then
    update files set open_count = open_count + 1, last_opened_at = now() where id = fid;
  else
    update files set last_opened_at = now() where id = fid;
  end if;
  if v_first then
    if v_reader > 0 then update profiles set points = points + v_reader where id = v_uid; end if;
    if v_owner is not null then
      update profiles set points = points + v_view where id = v_owner;
    else
      select email into v_email from import_pending where file_id = fid;
      if v_email is not null then
        update import_credits set view_points = view_points + v_view where email = v_email;
      end if;
    end if;
  end if;
end $$;

-- File eliminabili automaticamente da un archivio, dal meno utile al più utile.
-- Aperture contate nell'ultimo anno per le registrazioni, nell'ultimo anno e mezzo per i documenti.
drop function if exists public.b2_eviction_order();
create or replace function public.storage_eviction_order(st text)
returns table(file_id bigint, file_title text, bytes bigint, opens bigint, last_activity timestamptz, path text, version text)
language sql stable security definer set search_path = public as $$
  select f.id, f.title, f.size,
         (select count(*) from file_opens o
           where o.file_id = f.id and o.day > current_date - (case when f.kind in ('audio', 'video')
             then public.setting_int('evict_window_days', 365) else public.setting_int('evict_window_days_docs', 548) end)::int),
         coalesce(f.last_opened_at, f.created_at),
         f.storage_path, f.storage_version
  from files f
  where f.storage = st and not f.pinned
    and f.created_at < now() - make_interval(days => public.setting_int('evict_grace_days', 14)::int)
    and (f.imported_at is null or f.imported_at < now() - make_interval(days => public.setting_int('import_grace_days', 183)::int))
  order by 4 asc, 5 asc, f.id asc
$$;
revoke execute on function public.storage_eviction_order(text) from public, anon, authenticated;

-- Anteprima per gli amministratori: i prossimi file che verrebbero eliminati
create or replace function public.storage_eviction_preview(st text, lim integer default 5)
returns table(file_id bigint, file_title text, bytes bigint, opens bigint, last_activity timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  return query select e.file_id, e.file_title, e.bytes, e.opens, e.last_activity
    from public.storage_eviction_order(st) e limit greatest(1, least(lim, 50));
end $$;
create or replace function public.b2_eviction_preview(lim integer default 5)
returns table(file_id bigint, file_title text, bytes bigint, opens bigint, last_activity timestamptz)
language sql stable security definer set search_path = public as $$
  select * from public.storage_eviction_preview('b2', lim)
$$;

-- Fa spazio per un nuovo caricamento eliminando SOLO il necessario, e solo dallo stesso archivio.
-- Restituisce i file eliminati (la funzione "B2" li cancella poi dall'archivio).
create or replace function public.storage_make_room(st text, needed bigint)
returns table(file_id bigint, path text, version text, bytes bigint, file_title text)
language plpgsql security definer set search_path = public as $$
declare
  v_needed  bigint := greatest(0, least(coalesce(needed, 0), 524288000));  -- max 500 MB
  v_deficit bigint;
  v_avail   bigint;
begin
  if not public.is_campus() then raise exception 'Accesso negato'; end if;
  if st not in ('b2', 'r2') then raise exception 'Archivio non valido'; end if;
  v_deficit := public.storage_used(st) + v_needed - public.storage_quota(st);
  if v_deficit <= 0 then return; end if;
  select coalesce(sum(e.bytes), 0) into v_avail from public.storage_eviction_order(st) e;
  if v_avail < v_deficit then
    raise exception 'Spazio dell''archivio esaurito: non ci sono abbastanza file vecchi o poco usati da eliminare.';
  end if;
  perform set_config('app.auto_evict', '1', true);
  return query
    with ranked as (
      select e.file_id, e.bytes,
             sum(e.bytes) over (order by e.opens, e.last_activity, e.file_id) as running
      from public.storage_eviction_order(st) e
    ), deleted as (
      delete from files f using ranked r
      where f.id = r.file_id and r.running - r.bytes < v_deficit
      returning f.id, f.storage_path, f.storage_version, f.size, f.title
    )
    select * from deleted;
  perform set_config('app.auto_evict', '', true);
end $$;
create or replace function public.b2_make_room(needed bigint)
returns table(file_id bigint, path text, version text, bytes bigint, file_title text)
language sql security definer set search_path = public as $$
  select * from public.storage_make_room('b2', needed)
$$;

-- Protegge un file dall'eliminazione automatica (solo amministratori)
create or replace function public.set_pinned(fid bigint, value boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_title text;
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  update files set pinned = value where id = fid returning title into v_title;
  if v_title is null then raise exception 'File non trovato'; end if;
  insert into audit_log (user_id, action, details)
  values (auth.uid(), case when value then 'file_protetto' else 'file_non_protetto' end, v_title);
end $$;

-- Punti della classifica: +10 per file (max 10 file al giorno), -10 se un admin
-- elimina il file. Né la pulizia automatica né l'eliminazione di un corso tolgono punti.
create or replace function public.award_points()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.importing', true), '') = '1' or coalesce(current_setting('app.robot', true), '') = '1' then
    return null;  -- importazione e robot: punti gestiti a parte (import_register)
  end if;
  if tg_op = 'INSERT' and new.uploaded_by is not null then
    update profiles set upload_count = upload_count + 1,
      points = points + case when (select count(*) from files
        where uploaded_by = new.uploaded_by and created_at >= date_trunc('day', now()) and id <= new.id) <= 10 then 10 else 0 end
    where id = new.uploaded_by;
  elsif tg_op = 'DELETE' and old.uploaded_by is not null
        and coalesce(current_setting('app.auto_evict', true), '') <> '1'
        and exists (select 1 from courses where id = old.course_id) then  -- se il corso è stato eliminato, niente penalità
    update profiles set points = greatest(0, points - 10), upload_count = greatest(0, upload_count - 1)
    where id = old.uploaded_by;
  end if;
  return null;
end $$;
drop trigger if exists award_points on public.files;
create trigger award_points after insert or delete on public.files
  for each row execute function public.award_points();

-- Calcolo iniziale dei punti per i file caricati prima della classifica (una sola volta)
do $$ begin
  if not exists (select 1 from app_settings where key = 'points_initialized') then
    update profiles p set
      upload_count = (select count(*) from files f where f.uploaded_by = p.id),
      points = 10 * (select count(*) from files f where f.uploaded_by = p.id)
             + (select count(*) from file_opens o join files f on f.id = o.file_id
                where f.uploaded_by = p.id and o.user_id <> p.id);
    insert into app_settings (key, value) values ('points_initialized', 'true');
  end if;
end $$;

-- Nuove regole dei punti per le aperture (una volta sola): da +1 per apertura giornaliera
-- a +5 per ogni studente diverso; +1 a chi apre un file per la prima volta (max 5 al giorno)
do $$ begin
  if not exists (select 1 from app_settings where key = 'points_v2') then
    update profiles p set points = greatest(0, p.points
      - (select count(*) from file_opens o join files f on f.id = o.file_id where f.uploaded_by = p.id and o.user_id <> p.id)
      + 5 * (select count(distinct (o.file_id, o.user_id)) from file_opens o join files f on f.id = o.file_id
             where f.uploaded_by = p.id and o.user_id <> p.id));
    with firsts as (
      select o.user_id, o.file_id, min(o.day) as d from file_opens o join files f on f.id = o.file_id
      where f.uploaded_by is distinct from o.user_id group by o.user_id, o.file_id
    ), perday as (
      select user_id, least(count(*), 5) as n from firsts group by user_id, d
    )
    update profiles p set points = p.points + coalesce((select sum(n) from perday where perday.user_id = p.id), 0);
    update import_credits c set view_points = view_points + 5 * (
      select count(distinct (o.file_id, o.user_id)) from file_opens o join import_pending ip on ip.file_id = o.file_id
      where ip.email = c.email);
    insert into app_settings (key, value) values ('points_v2', 'true');
  end if;
end $$;

-- Chi era già iscritto quando è arrivato il tour non lo vede in automatico (solo i nuovi account)
do $$ begin
  if not exists (select 1 from app_settings where key = 'tour_init') then
    update profiles set onboarded_at = coalesce(onboarded_at, now());
    insert into app_settings (key, value) values ('tour_init', 'true');
  end if;
end $$;

create or replace function public.tour_pending()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_campus() and exists (select 1 from profiles where id = auth.uid() and onboarded_at is null)
$$;

create or replace function public.tour_done()
returns void language sql volatile security definer set search_path = public as $$
  update profiles set onboarded_at = coalesce(onboarded_at, now()) where id = auth.uid() and public.is_campus()
$$;

-- Ultima visita: restituisce la visita precedente (i file più recenti sono "Nuovi").
-- Dentro la stessa sessione (meno di un'ora tra un'apertura e l'altra) il riferimento non cambia.
create or replace function public.visit()
returns timestamptz language plpgsql volatile security definer set search_path = public as $$
declare v_seen timestamptz; v_prev timestamptz; v_created timestamptz;
begin
  if not public.is_campus() then return null; end if;
  select seen_at, prev_seen_at, created_at into v_seen, v_prev, v_created from profiles where id = auth.uid();
  if v_seen is null or v_seen < now() - interval '1 hour' then
    v_prev := coalesce(v_seen, v_created, now());
    update profiles set prev_seen_at = v_prev, seen_at = now() where id = auth.uid();
  else
    update profiles set seen_at = now() where id = auth.uid();
  end if;
  return v_prev;
end $$;

-- Voto "Utile 👍": aggiunge o toglie il proprio voto; +3/−3 punti a chi ha caricato
create or replace function public.toggle_vote(fid bigint)
returns json language plpgsql volatile security definer set search_path = public as $$
declare v_owner uuid; v_pts int := public.setting_int('points_per_vote', 3); v_voted boolean; v_email text; v_count int;
begin
  if not public.is_campus() then raise exception 'Accesso negato'; end if;
  select uploaded_by into v_owner from files where id = fid;
  if not found then raise exception 'File non trovato'; end if;
  if v_owner = auth.uid() then raise exception 'Non puoi votare i tuoi file'; end if;
  delete from file_votes where file_id = fid and user_id = auth.uid();
  if found then v_voted := false; v_pts := -v_pts;
  else insert into file_votes (file_id, user_id) values (fid, auth.uid()); v_voted := true;
  end if;
  update files set vote_count = greatest(0, vote_count + case when v_voted then 1 else -1 end) where id = fid returning vote_count into v_count;
  if v_owner is not null then
    update profiles set points = greatest(0, points + v_pts) where id = v_owner;
  else
    select email into v_email from import_pending where file_id = fid;
    if v_email is not null then update import_credits set view_points = greatest(0, view_points + v_pts) where email = v_email; end if;
  end if;
  return json_build_object('voted', v_voted, 'count', v_count);
end $$;

-- Quali di questi file ho votato
create or replace function public.my_votes(ids bigint[])
returns setof bigint language sql stable security definer set search_path = public as $$
  select file_id from file_votes where user_id = auth.uid() and file_id = any(ids) and public.is_campus()
$$;

-- Cartella di un file: chi l'ha caricato o un amministratore
create or replace function public.set_folder(fid bigint, name text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_campus() then raise exception 'Accesso negato'; end if;
  update files set folder = left(nullif(trim(name), ''), 120)
  where id = fid and (uploaded_by = auth.uid() or public.is_admin());
  if not found then raise exception 'Solo chi ha caricato il file o un amministratore può cambiarne la cartella'; end if;
end $$;

-- Statistiche per la pagina Amministrazione
create or replace function public.admin_stats()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  return json_build_object(
    'active_7d', (select count(distinct user_id) from (
        select user_id from file_opens where day > current_date - 7
        union select uploaded_by from files where created_at > now() - interval '7 days' and imported_at is null) a where user_id is not null),
    'opens_7d', (select count(*) from file_opens where day > current_date - 7),
    'uploads_7d', (select count(*) from files where created_at > now() - interval '7 days' and imported_at is null),
    'new_users_7d', (select count(*) from profiles where created_at > now() - interval '7 days'),
    'top_files', (select coalesce(json_agg(t), '[]'::json) from (
        select f.id, f.title, f.open_count, f.vote_count, c.name as course from files f join courses c on c.id = f.course_id
        order by f.open_count desc, f.vote_count desc, f.id limit 8) t),
    'top_courses', (select coalesce(json_agg(t), '[]'::json) from (
        select c.id, c.name, c.year, count(o.*) as opens from courses c join files f on f.course_id = c.id
        join file_opens o on o.file_id = f.id and o.day > current_date - 30
        group by c.id order by opens desc limit 8) t));
end $$;

-- Classifica: solo utenti attivi, senza dati riservati
create or replace function public.leaderboard()
returns table(user_id uuid, name text, points integer, upload_count integer, role text, rank_pos bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.points, p.upload_count, p.role,
         rank() over (order by p.points desc, p.upload_count desc)
  from profiles p
  where public.is_campus() and p.banned_at is null
  order by p.points desc, p.upload_count desc, p.name
$$;

-- Elenco completo degli utenti per gli amministratori (con lo stato di sospensione)
create or replace function public.admin_users()
returns table(id uuid, email text, name text, role text, points integer, upload_count integer,
              banned_at timestamptz, banned_reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  return query select p.id, p.email, p.name, p.role, p.points, p.upload_count, p.banned_at, p.banned_reason, p.created_at
    from profiles p order by p.role = 'admin' desc, p.banned_at is not null, p.name;
end $$;

-- Sospendere / riattivare un utente
create or replace function public.ban_user(target uuid, reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text; v_role text;
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  select email, role into v_email, v_role from profiles where id = target;
  if v_email is null then raise exception 'Utente non trovato'; end if;
  if target = auth.uid() then raise exception 'Non puoi sospendere te stesso'; end if;
  if v_role = 'admin' then raise exception 'Prima revoca il ruolo di amministratore'; end if;
  if coalesce(trim(reason), '') = '' then raise exception 'Indica il motivo della sospensione'; end if;
  update profiles set banned_at = now(), banned_reason = left(trim(reason), 300), banned_by = auth.uid() where id = target;
  insert into audit_log (user_id, action, details) values (auth.uid(), 'utente_sospeso', v_email || ': ' || left(trim(reason), 300));
end $$;

create or replace function public.unban_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  update profiles set banned_at = null, banned_reason = null, banned_by = null where id = target returning email into v_email;
  if v_email is null then raise exception 'Utente non trovato'; end if;
  insert into audit_log (user_id, action, details) values (auth.uid(), 'utente_riattivato', v_email);
end $$;

-- =============================================================================
--  Importazione dal vecchio Google Drive e robot di compressione
--  Lo script Google e il robot di GitHub non hanno un account: si identificano con un
--  "codice di servizio" generato da un amministratore (qui ne resta solo l'impronta).
-- =============================================================================

-- Anno accademico in forma "2024/2025" (come nel sito: accetta "2024-25", "24/25", "2024"…)
create or replace function public.norm_aa(v text)
returns text language plpgsql immutable as $$
declare m text[]; y int;
begin
  m := regexp_match(coalesce(v, ''), '(\d{4}|\d{2})\s*[/\-–]\s*(\d{4}|\d{2})');
  if m is not null then y := m[1]::int;
  else
    m := regexp_match(coalesce(v, ''), '(?:^|\D)(\d{4})(?:\D|$)');
    if m is null then return null; end if;
    y := m[1]::int;
  end if;
  if y < 100 then y := y + 2000; end if;
  if y < 1990 or y > 2100 then return null; end if;
  return y || '/' || (y + 1);
end $$;

create or replace function public.service_ok(token text)
returns boolean language sql stable security definer set search_path = public as $$
  select length(coalesce(token, '')) >= 32 and exists (
    select 1 from app_settings where key = 'service_token_hash'
      and value = encode(sha256(convert_to(token, 'UTF8')), 'hex'))
$$;
revoke execute on function public.service_ok(text) from public, anon, authenticated;

create or replace function public.require_service(token text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.service_ok(token) then raise exception 'Codice di servizio non valido'; end if;
end $$;
revoke execute on function public.require_service(text) from public, anon, authenticated;

-- Verifica del codice (usata dalla funzione "B2" per le azioni di importazione)
create or replace function public.service_ping(token text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.service_ok(token)
$$;

-- Proprietario del sito: il primo account registrato (diventato admin in automatico).
-- Solo lui può rigenerare il codice di servizio.
insert into public.app_settings (key, value)
select 'owner_id', id::text from public.profiles order by created_at, id limit 1
on conflict (key) do nothing;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() and auth.uid()::text = coalesce(
    (select value from app_settings where key = 'owner_id'),
    (select id::text from profiles order by created_at, id limit 1))
$$;

-- Nuovo codice di servizio (solo il proprietario). Il vecchio smette di funzionare.
create or replace function public.new_service_token()
returns text language plpgsql volatile security definer set search_path = public as $$
declare t text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.is_owner() then raise exception 'Solo il proprietario del sito può generare il codice di servizio'; end if;
  insert into app_settings (key, value) values ('service_token_hash', encode(sha256(convert_to(t, 'UTF8')), 'hex'))
  on conflict (key) do update set value = excluded.value;
  insert into audit_log (user_id, action) values (auth.uid(), 'codice_servizio_generato');
  return t;
end $$;

-- Controllo prima di trasferire un file: 'ok', 'exists' (già importato), 'full' (aspettare la compressione), 'too_big'
create or replace function public.import_prepare(token text, p_drive_id text, p_store text, p_size bigint)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_service(token);
  if p_store not in ('b2', 'r2') then raise exception 'Archivio non valido'; end if;
  if exists (select 1 from files where drive_id = p_drive_id) then return 'exists'; end if;
  if coalesce(p_size, 0) > public.setting_int('import_max_mb', 3000) * 1048576 then return 'too_big'; end if;
  if public.storage_used(p_store) + coalesce(p_size, 0) > public.storage_quota(p_store) then return 'full'; end if;
  return 'ok';
end $$;

-- Registra un file importato: crea il corso se serve, attribuisce file e punti all'autore
-- (subito se è già iscritto, altrimenti al suo primo accesso).
create or replace function public.import_register(token text, p jsonb)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  v_id     bigint;
  v_course bigint;
  v_aa     text := public.norm_aa(p ->> 'aa');
  v_degree text := p ->> 'degree';
  v_year   int  := nullif(p ->> 'study_year', '')::int;
  v_email  text := lower(nullif(trim(p ->> 'owner'), ''));
  v_user   uuid;
  v_per    int  := public.setting_int('import_points_per_file', 10);
  v_cap    int  := public.setting_int('import_points_cap', 0);   -- 0 = nessun tetto
  v_files  int;
  v_delta  int;
begin
  perform public.require_service(token);
  select id into v_id from files where drive_id = p ->> 'drive_id';
  if v_id is not null then return v_id; end if;

  if not (v_degree = 'triennale' and v_year between 1 and 3 or v_degree = 'magistrale' and v_year between 1 and 2) then
    v_degree := null; v_year := null;   -- "Da assegnare"
  end if;
  select id into v_course from courses
  where lower(name) = lower(p ->> 'course') and coalesce(public.norm_aa(year), '') = coalesce(v_aa, '')
  order by id limit 1;
  if v_course is null then
    insert into courses (name, year, degree, study_year, description)
    values (left(p ->> 'course', 140), v_aa, v_degree, v_year, 'Materiali importati dal vecchio Drive dei rappresentanti.')
    returning id into v_course;
  end if;

  if v_email is not null then select id into v_user from profiles where email = v_email; end if;
  perform set_config('app.importing', '1', true);
  insert into files (course_id, title, description, original_name, storage_path, storage, storage_version,
                     mime, kind, size, uploaded_by, created_at, imported_at, drive_id, needs_processing, folder)
  values (v_course, left(coalesce(nullif(p ->> 'title', ''), p ->> 'name'), 200), left(nullif(p ->> 'description', ''), 2000),
          left(p ->> 'name', 255), p ->> 'path', p ->> 'store', nullif(p ->> 'version', ''),
          p ->> 'mime', p ->> 'kind', (p ->> 'size')::bigint, v_user,
          coalesce((p ->> 'created')::timestamptz, now()), now(), p ->> 'drive_id',
          coalesce((p ->> 'needs_processing')::boolean, false),
          left(nullif(trim(coalesce(p ->> 'folder', substring(p ->> 'description' from 'Cartella: (.+)$'))), ''), 120))
  returning id into v_id;
  perform set_config('app.importing', '', true);

  if v_email is not null then
    insert into import_credits (email, files) values (v_email, 1)
    on conflict (email) do update set files = import_credits.files + 1
    returning files into v_files;
    v_delta := (case when v_cap > 0 then least(v_files * v_per, v_cap) else v_files * v_per end)
               - (select points from import_credits where email = v_email);
    update import_credits set points = points + v_delta where email = v_email;
    if v_user is not null then
      update profiles set points = points + v_delta, upload_count = upload_count + 1 where id = v_user;
      update import_credits set paid = paid + v_delta where email = v_email;
    else
      insert into import_pending (file_id, email) values (v_id, v_email);
    end if;
  end if;
  return v_id;
end $$;

-- Nome dell'autore di un file importato (mostrato finché non si iscrive; i punti arrivano solo col login)
create or replace function public.import_set_author(token text, p_drive_id text, p_name text)
returns integer language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  perform public.require_service(token);
  update files set author_name = left(nullif(trim(p_name), ''), 120)
  where drive_id = p_drive_id or drive_id like replace(replace(p_drive_id, '%', '\%'), '_', '\_') || '#%';
  get diagnostics n = row_count;
  return n;
end $$;

-- Robot: registrazioni da comprimere (o ZIP da scompattare)
create or replace function public.robot_pending(token text, lim integer default 50)
returns table(id bigint, storage text, storage_path text, storage_version text, kind text, mime text, original_name text, size bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_service(token);
  return query select f.id, f.storage, f.storage_path, f.storage_version, f.kind, f.mime, f.original_name, f.size
    from files f where f.needs_processing order by f.id limit greatest(1, least(lim, 500));
end $$;

-- Robot: file compresso al posto dell'originale (false se nel frattempo è stato eliminato)
create or replace function public.robot_done(token text, p_id bigint, p_path text, p_version text, p_size bigint, p_mime text, p_name text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_service(token);
  update files set storage_path = p_path, storage_version = nullif(p_version, ''), size = p_size,
    mime = p_mime, original_name = left(p_name, 255), needs_processing = false, processing_error = null
  where id = p_id and needs_processing;
  return found;
end $$;

create or replace function public.robot_failed(token text, p_id bigint, msg text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_service(token);
  update files set needs_processing = false, processing_error = left(coalesce(msg, 'errore'), 300) where id = p_id;
end $$;

-- Robot: una lezione estratta da uno ZIP (stesso corso, autore e date dell'archivio, nessun punto extra).
-- Ogni lezione è riconosciuta dal suo nome nello ZIP: se il robot viene interrotto, riprende senza doppioni.
create or replace function public.robot_add(token text, parent_id bigint, p jsonb)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint; f files; v_drive text;
begin
  perform public.require_service(token);
  select * into f from files where id = parent_id;
  if f.id is null then raise exception 'Archivio non trovato'; end if;
  v_drive := coalesce(f.drive_id, 'file' || f.id) || '#' || coalesce(p ->> 'member', p ->> 'name');
  select id into v_id from files where drive_id = v_drive;
  if v_id is not null then return v_id; end if;
  perform set_config('app.importing', '1', true);
  perform set_config('app.robot', '1', true);
  insert into files (course_id, title, description, original_name, storage_path, storage, storage_version,
                     mime, kind, size, uploaded_by, created_at, imported_at, drive_id, needs_processing)
  values (f.course_id, left(coalesce(nullif(p ->> 'title', ''), p ->> 'name'), 200), f.description,
          left(p ->> 'name', 255), p ->> 'path', f.storage, nullif(p ->> 'version', ''),
          p ->> 'mime', p ->> 'kind', (p ->> 'size')::bigint, f.uploaded_by, f.created_at, f.imported_at, v_drive, false)
  returning id into v_id;
  update files set author_name = f.author_name, folder = f.folder where id = v_id;
  insert into import_pending (file_id, email) select v_id, email from import_pending where file_id = parent_id;
  perform set_config('app.importing', '', true);
  perform set_config('app.robot', '', true);
  return v_id;
end $$;

-- Robot: lezioni di uno ZIP già estratte (per riprendere dopo un'interruzione)
create or replace function public.robot_extracted(token text, parent_id bigint)
returns setof text language plpgsql stable security definer set search_path = public as $$
declare v_prefix text;
begin
  perform public.require_service(token);
  select coalesce(drive_id, 'file' || id) || '#' into v_prefix from files where id = parent_id;
  return query select substr(drive_id, length(v_prefix) + 1) from files where drive_id like replace(replace(v_prefix, '%', '\%'), '_', '\_') || '%';
end $$;

-- Robot: rimuove l'archivio ZIP dopo averlo scompattato (senza togliere punti)
create or replace function public.robot_remove(token text, p_id bigint)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_service(token);
  perform set_config('app.robot', '1', true);
  delete from files where id = p_id;   -- lo ZIP conta comunque come un caricamento per i punti
  perform set_config('app.robot', '', true);
end $$;

-- Stato dell'importazione per la pagina Amministrazione
create or replace function public.import_status()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Operazione riservata agli amministratori'; end if;
  return json_build_object(
    'has_token', exists (select 1 from app_settings where key = 'service_token_hash'),
    'is_owner', public.is_owner(),
    'imported', (select count(*) from files where imported_at is not null),
    'imported_b2', (select count(*) from files where imported_at is not null and storage = 'b2'),
    'imported_r2', (select count(*) from files where imported_at is not null and storage = 'r2'),
    'processing', (select count(*) from files where needs_processing),
    'authors', (select count(*) from import_credits),
    'authors_waiting', (select count(distinct email) from import_pending),
    'errors', (select coalesce(json_agg(json_build_object('id', id, 'title', title, 'error', processing_error) order by id), '[]'::json)
               from (select id, title, processing_error from files where processing_error is not null order by id limit 20) e),
    'last', (select max(imported_at) from files));
end $$;

-- Contenuti iniziali della pagina Rappresentanti (solo informazioni pubbliche, una volta sola)
do $$ begin
  if not exists (select 1 from app_settings where key = 'info_seeded') then
    insert into info_links (section, label, detail, url, sort_order) values
      ('siti', 'e-Learning di Ateneo', 'Corsi, materiali e comunicazioni dei docenti', 'https://elearning.unimib.it/', 1),
      ('siti', 'Gestione didattica', 'Orari delle lezioni, calendario esami, occupazione aule…', 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/index.php?view=home&_lang=it', 2),
      ('siti', 'Sito dell''Università', 'unimib.it', 'https://www.unimib.it/', 3),
      ('siti', 'Segreteria online', 'Iscrizioni, esami, tasse e carriera', 'https://s3w.si.unimib.it/', 4),
      ('app', 'UniMIB Course', 'Orari e aule sul telefono', 'https://play.google.com/store/apps/details?id=it.easystaff.unimib&hl=it', 1),
      ('app', 'BicoccApp', 'L''app ufficiale dell''Ateneo', 'https://play.google.com/store/apps/details?id=it.bicoccapp.unimib&hl=it', 2),
      ('sicurezza', 'Controllo sulle buone pratiche di sicurezza in laboratorio', 'Corso obbligatorio su e-Learning', 'https://elearning.unimib.it/course/view.php?id=28448', 1),
      ('sicurezza', 'Formazione generale dei lavoratori', 'Corso obbligatorio su e-Learning', 'https://elearning.unimib.it/enrol/index.php?id=53765', 2),
      ('esami', 'Chimica Generale (Di Credico)', 'Primo anno · 14 CFU', null, 1),
      ('esami', 'Chimica Inorganica I (Scotti)', 'Secondo anno · 10 CFU', null, 2),
      ('esami', 'Analitica Strumentale (Gosetti)', 'Terzo anno · 12 CFU', null, 3),
      ('rappresentanza', 'Come fare il rappresentante?', 'Tutte le informazioni e i contatti', 'https://linktr.ee/splunimib', 1);
    insert into app_settings (key, value) values ('info_seeded', 'true');
  end if;
end $$;

-- Permessi (Row Level Security) ----------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.courses   enable row level security;
alter table public.files     enable row level security;
alter table public.audit_log enable row level security;
alter table public.file_opens enable row level security;
alter table public.course_visits enable row level security;
alter table public.import_pending enable row level security;
alter table public.import_credits enable row level security;
alter table public.course_favorites enable row level security;
alter table public.file_votes enable row level security;
alter table public.app_settings enable row level security;
alter table public.reports enable row level security;
alter table public.representatives enable row level security;
alter table public.info_links enable row level security;
alter table public.professors enable row level security;
revoke all on public.file_opens, public.app_settings, public.course_visits, public.import_pending, public.import_credits, public.file_votes from anon, authenticated;
revoke all on public.course_favorites from anon;
grant select, insert, delete on public.course_favorites to authenticated;
drop policy if exists "preferiti: solo i propri" on public.course_favorites;
create policy "preferiti: solo i propri" on public.course_favorites
  for all to authenticated using (public.is_campus() and user_id = auth.uid()) with check (public.is_campus() and user_id = auth.uid());

drop policy if exists "profili visibili agli studenti" on public.profiles;
create policy "profili visibili agli studenti" on public.profiles
  for select to authenticated using (public.is_campus());

drop policy if exists "corsi visibili" on public.courses;
create policy "corsi visibili" on public.courses
  for select to authenticated using (public.is_campus());
drop policy if exists "corsi: tutti possono creare" on public.courses;
create policy "corsi: tutti possono creare" on public.courses
  for insert to authenticated with check (public.is_campus());
drop policy if exists "corsi: solo admin modificano" on public.courses;
create policy "corsi: solo admin modificano" on public.courses
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "corsi: solo admin eliminano" on public.courses;
create policy "corsi: solo admin eliminano" on public.courses
  for delete to authenticated using (public.is_admin());

drop policy if exists "file visibili" on public.files;
create policy "file visibili" on public.files
  for select to authenticated using (public.is_campus());
drop policy if exists "file: tutti possono caricare" on public.files;
create policy "file: tutti possono caricare" on public.files
  for insert to authenticated
  with check (public.is_campus() and split_part(storage_path, '/', 1) = auth.uid()::text);
drop policy if exists "file: solo admin eliminano" on public.files;
create policy "file: solo admin eliminano" on public.files
  for delete to authenticated using (public.is_admin());

drop policy if exists "rappresentanti: lettura studenti" on public.representatives;
create policy "rappresentanti: lettura studenti" on public.representatives
  for select to authenticated using (public.is_campus());
drop policy if exists "rappresentanti: gestione admin" on public.representatives;
create policy "rappresentanti: gestione admin" on public.representatives
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "docenti: lettura studenti" on public.professors;
create policy "docenti: lettura studenti" on public.professors
  for select to authenticated using (public.is_campus());
drop policy if exists "docenti: gestione admin" on public.professors;
create policy "docenti: gestione admin" on public.professors
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "link: lettura studenti" on public.info_links;
create policy "link: lettura studenti" on public.info_links
  for select to authenticated using (public.is_campus());
drop policy if exists "link: gestione admin" on public.info_links;
create policy "link: gestione admin" on public.info_links
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "segnalazioni: studenti segnalano" on public.reports;
create policy "segnalazioni: studenti segnalano" on public.reports
  for insert to authenticated with check (public.is_campus() and user_id = auth.uid());
drop policy if exists "segnalazioni: admin leggono" on public.reports;
create policy "segnalazioni: admin leggono" on public.reports
  for select to authenticated using (public.is_admin());
drop policy if exists "segnalazioni: admin archiviano" on public.reports;
create policy "segnalazioni: admin archiviano" on public.reports
  for delete to authenticated using (public.is_admin());

drop policy if exists "registro: solo admin" on public.audit_log;
create policy "registro: solo admin" on public.audit_log
  for select to authenticated using (public.is_admin());

revoke all on public.profiles, public.courses, public.files, public.audit_log, public.reports from anon, authenticated;
-- Dei profili gli studenti vedono solo i dati pubblici (non lo stato di sospensione)
grant select (id, email, name, role, created_at, points, upload_count) on public.profiles to authenticated;
grant select on public.audit_log to authenticated;
grant select, insert, delete on public.reports to authenticated;
revoke all on public.representatives, public.info_links, public.professors from anon;
grant select, insert, update, delete on public.representatives, public.info_links, public.professors to authenticated;
grant select, insert, update, delete on public.courses, public.files to authenticated;
revoke execute on function public.set_role(uuid, text) from public, anon;
grant execute on function public.set_role(uuid, text) to authenticated;

-- Archivio file (Storage) -----------------------------------------------------------
-- Cartella privata "materiali", max 50 MB per file (limite del piano gratuito),
-- solo i formati ammessi (niente HTML/SVG/eseguibili).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('materiali', 'materiali', false, 52428800, array[
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/opus', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain', 'application/zip'
])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "materiali: lettura studenti" on storage.objects;
create policy "materiali: lettura studenti" on storage.objects
  for select to authenticated
  using (bucket_id = 'materiali' and public.is_campus());

drop policy if exists "materiali: caricamento studenti" on storage.objects;
create policy "materiali: caricamento studenti" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'materiali' and public.is_campus()
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "materiali: eliminazione admin" on storage.objects;
create policy "materiali: eliminazione admin" on storage.objects
  for delete to authenticated
  using (bucket_id = 'materiali' and public.is_admin());
