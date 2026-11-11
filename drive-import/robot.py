"""Robot di compressione delle registrazioni (eseguito da GitHub Actions, vedi .github/workflows/robot.yml).

Per ogni registrazione su Cloudflare R2 ancora da elaborare:
  - audio → AAC mono 48 kbps (.m4a): qualità voce, circa 20 MB per ora di lezione
  - video → H.264 720p (.mp4)
  - ZIP di registrazioni → scompattato: ogni lezione diventa un file del corso (poi compressa)
Il file compresso sostituisce l'originale solo se è davvero più piccolo.
Nessun dato personale nei log: solo numero e nome dei file.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
TOKEN = os.environ.get('SERVICE_TOKEN', '')
BUCKET = os.environ.get('R2_BUCKET', '')
TIME_BUDGET = float(os.environ.get('TIME_BUDGET_MIN', '300')) * 60  # GitHub ferma i lavori dopo 6 ore
AUDIO_EXT = {'.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.wma', '.amr', '.3gp'}
VIDEO_EXT = {'.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv'}
MIN_SAVING = 0.9  # teniamo la versione compressa solo se pesa meno del 90% dell'originale


def rpc(name, args):
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/rpc/{name}', data=json.dumps(args).encode(), method='POST',
        headers={'apikey': SUPABASE_KEY, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        body = res.read().decode()
    return json.loads(body) if body else None


def s3_client():
    import boto3  # caricato solo quando serve: il controllo iniziale gira senza
    from botocore.config import Config
    endpoint = os.environ.get('R2_ENDPOINT') or f"https://{os.environ.get('R2_ACCOUNT_ID', '')}.r2.cloudflarestorage.com"
    return boto3.client(
        's3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=os.environ.get('R2_KEY_ID'), aws_secret_access_key=os.environ.get('R2_APP_KEY'),
        config=Config(signature_version='s3v4', retries={'max_attempts': 5}))


def run(cmd):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or 'ffmpeg non riuscito').strip().splitlines()[-1][:250])


def compress(src: Path, kind: str, out_dir: Path) -> Path:
    """Restituisce il file compresso (.m4a per l'audio, .mp4 per il video)."""
    base = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(src)]
    if kind == 'audio':
        out = out_dir / (src.stem + '-compresso.m4a')
        run(base + ['-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', str(out)])
    else:
        out = out_dir / (src.stem + '-compresso.mp4')
        run(base + ['-vf', "scale=-2:'min(720,ih)'", '-fpsmax', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-b:a', '64k', '-movflags', '+faststart', str(out)])
    return out


def kind_of(path: Path):
    ext = path.suffix.lower()
    return 'audio' if ext in AUDIO_EXT else 'video' if ext in VIDEO_EXT else None


def mime_of(kind):
    return 'audio/mp4' if kind == 'audio' else 'video/mp4'


def new_key(ext):
    return f'import/{uuid.uuid4()}{ext}'


def process_media(s3, f, work: Path):
    """Comprime una registrazione e sostituisce l'originale."""
    src = work / ('originale' + Path(f['storage_path']).suffix)
    s3.download_file(BUCKET, f['storage_path'], str(src))
    out = compress(src, f['kind'], work)
    name = Path(f['original_name']).stem + out.suffix
    if out.stat().st_size >= src.stat().st_size * MIN_SAVING:
        # già leggero: resta com'è
        rpc('robot_done', {'token': TOKEN, 'p_id': f['id'], 'p_path': f['storage_path'], 'p_version': f.get('storage_version') or '',
                           'p_size': f['size'], 'p_mime': f['mime'], 'p_name': f['original_name']})
        return f"già leggero ({f['size'] // 1048576} MB)"
    key = new_key(out.suffix)
    s3.upload_file(str(out), BUCKET, key, ExtraArgs={'ContentType': mime_of(f['kind'])})
    size = out.stat().st_size
    if rpc('robot_done', {'token': TOKEN, 'p_id': f['id'], 'p_path': key, 'p_version': '', 'p_size': size,
                          'p_mime': mime_of(f['kind']), 'p_name': name}):
        s3.delete_object(Bucket=BUCKET, Key=f['storage_path'])
    else:  # nel frattempo il file è stato eliminato dal sito
        s3.delete_object(Bucket=BUCKET, Key=key)
    return f"{f['size'] // 1048576} MB → {size // 1048576} MB"


def process_zip(s3, f, work: Path, deadline: float):
    """Scompatta uno ZIP di registrazioni: ogni lezione diventa un file del corso.
    Se il tempo finisce a metà, l'esecuzione successiva riprende dalle lezioni mancanti."""
    src = work / 'archivio.zip'
    s3.download_file(BUCKET, f['storage_path'], str(src))
    done = set(rpc('robot_extracted', {'token': TOKEN, 'parent_id': f['id']}) or [])
    added = 0
    with zipfile.ZipFile(src) as z:
        members = [m for m in z.infolist() if not m.is_dir() and '__MACOSX' not in m.filename
                   and not Path(m.filename).name.startswith('._') and kind_of(Path(m.filename))]
        if not members:
            raise RuntimeError('lo ZIP non contiene registrazioni')
        for m in sorted(members, key=lambda m: m.filename):
            if m.filename in done:
                continue
            if time.time() > deadline:
                return f'{len(done) + added} di {len(members)} lezioni estratte, continuo alla prossima esecuzione'
            inner = work / ('lezione' + Path(m.filename).suffix.lower())
            with z.open(m) as zf, open(inner, 'wb') as out_f:
                shutil.copyfileobj(zf, out_f)
            kind = kind_of(inner)
            try:  # sempre convertito: così ogni lezione è in un formato che si apre ovunque
                out = compress(inner, kind, work)
            except RuntimeError as err:
                print(f"   · {Path(m.filename).name}: saltato ({err})")
                continue
            title = Path(m.filename).stem
            key = new_key(out.suffix)
            s3.upload_file(str(out), BUCKET, key, ExtraArgs={'ContentType': mime_of(kind)})
            rpc('robot_add', {'token': TOKEN, 'parent_id': f['id'], 'p': {
                'path': key, 'size': out.stat().st_size, 'name': title + out.suffix, 'title': title,
                'kind': kind, 'mime': mime_of(kind), 'member': m.filename}})
            added += 1
            for p in (inner, out):
                p.unlink(missing_ok=True)
    if not added and not done:
        raise RuntimeError('nessuna registrazione leggibile nello ZIP')
    rpc('robot_remove', {'token': TOKEN, 'p_id': f['id']})
    s3.delete_object(Bucket=BUCKET, Key=f['storage_path'])
    return f'{len(done) + added} lezioni estratte'


def count_pending():
    """Per GitHub Actions: scrive pending=N, così ffmpeg si installa solo se c'è lavoro."""
    n = 0
    if TOKEN and SUPABASE_URL:
        n = len([f for f in rpc('robot_pending', {'token': TOKEN, 'lim': 20}) or [] if f['storage'] == 'r2'])
    print(f'Registrazioni da elaborare: {n}')
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as fh:
            fh.write(f'pending={n}\n')
    return 0


def main():
    if not (TOKEN and BUCKET and SUPABASE_URL):
        print('Robot non ancora configurato (Secrets mancanti): niente da fare.')
        return 0
    s3 = s3_client()
    start = time.time()
    done = 0
    seen = set()
    while time.time() - start < TIME_BUDGET:
        pending = [f for f in rpc('robot_pending', {'token': TOKEN, 'lim': 20}) or []
                   if f['storage'] == 'r2' and f['id'] not in seen]
        if not pending:
            break
        for f in pending:
            if time.time() - start > TIME_BUDGET:
                break
            seen.add(f['id'])
            work = Path(tempfile.mkdtemp(prefix='robot-'))
            try:
                is_zip = f['kind'] not in ('audio', 'video') and f['storage_path'].lower().endswith('.zip')
                if f['kind'] in ('audio', 'video'):
                    esito = process_media(s3, f, work)
                elif is_zip:
                    esito = process_zip(s3, f, work, start + TIME_BUDGET)
                else:
                    rpc('robot_failed', {'token': TOKEN, 'p_id': f['id'], 'msg': 'tipo di file non da comprimere'})
                    continue
                done += 1
                print(f"✓ #{f['id']} {f['original_name']}: {esito}", flush=True)
            except Exception as err:  # il file resta com'è, segnalato in Amministrazione
                print(f"✗ #{f['id']} {f['original_name']}: {err}", flush=True)
                try:
                    rpc('robot_failed', {'token': TOKEN, 'p_id': f['id'], 'msg': str(err)[:250]})
                except Exception as err2:
                    print('  (impossibile registrare l\'errore:', err2, ')')
            finally:
                shutil.rmtree(work, ignore_errors=True)
    print(f'Fine: {done} file elaborati in {int((time.time() - start) / 60)} minuti.')
    return 0


if __name__ == '__main__':
    sys.exit(count_pending() if '--pending' in sys.argv else main())
