#!/usr/bin/env python3
"""Back up your Samsung signing profile to an encrypted private archive."""

import argparse
import copy
import getpass
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "Soap4Samsung"
ARCHIVE = ROOT / ".local/certificates/Soap4Samsung.tar.gpg"


def password(gui, confirm):
    if gui:
        args = ["zenity", "--forms", "--title=Soap4Samsung — архив сертификатов",
                "--text=Пароль архива. Сохраните его в менеджере паролей.",
                "--separator=\n", "--add-password=Пароль архива"]
        if confirm:
            args.append("--add-password=Повторите пароль")
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode:
            raise SystemExit("Создание/открытие архива отменено.")
        values = result.stdout.removesuffix("\n").split("\n")
        if len(values) != (2 if confirm else 1):
            raise SystemExit("Не удалось прочитать пароль из локального окна.")
        value = values[0]
        repeated = values[-1]
    else:
        value = getpass.getpass("Пароль архива: ")
        repeated = getpass.getpass("Повторите пароль: ") if confirm else value
    if not value or value != repeated or "\n" in value or "\r" in value:
        raise SystemExit("Пароль пустой или подтверждение не совпало. Повторите команду.")
    return value


def crypt(data, secret, decrypt=False):
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, (secret + "\n").encode())
        os.close(write_fd)
        write_fd = None
        args = ["gpg", "--batch", "--no-symkey-cache", "--pinentry-mode", "loopback",
                "--passphrase-fd", str(read_fd)]
        args += ["--decrypt"] if decrypt else ["--symmetric", "--cipher-algo", "AES256",
                                                "--s2k-count", "65011712", "--output", "-"]
        result = subprocess.run(args, input=data, capture_output=True, pass_fds=(read_fd,))
        if result.returncode:
            raise SystemExit("GPG не смог обработать архив. Проверьте пароль и целостность файла.")
        return result.stdout
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)


def snapshot(profiles, profile_name=PROFILE, certificate_directory=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", profile_name):
        raise SystemExit("Имя профиля должно содержать только латинские буквы, цифры, '-' и '_'.")
    source = ET.parse(profiles).getroot()
    profile = next((p for p in source.findall("profile") if p.get("name") == profile_name), None)
    if profile is None:
        raise SystemExit("Указанный профиль не найден в Certificate Manager.")
    selected = ET.Element("profiles", {"active": profile_name, "version": source.get("version", "3.1")})
    selected.append(copy.deepcopy(profile))
    files = {"profile/profiles.xml": ET.tostring(selected, encoding="utf-8", xml_declaration=True)}
    for item in profile:
        if item.get("distributor") not in {"0", "1"}:
            continue
        path = Path(item.get("key", "")).expanduser()
        if not path.is_absolute():
            path = profiles.parent / path
        if not path.is_file():
            raise SystemExit("Файл активного сертификата не найден.")
        kind = "author" if item.get("distributor") == "0" else "distributor"
        files[f"active-profile/{kind}.p12"] = path.read_bytes()
    if not all(f"active-profile/{kind}.p12" in files for kind in ("author", "distributor")):
        raise SystemExit("Нужны оба активных сертификата: author и distributor.")
    directory = certificate_directory or Path.home() / "SamsungCertificate" / profile_name
    for path in sorted(directory.rglob("*")):
        if path.is_file() and not path.is_symlink():
            files[f"SamsungCertificate/{profile_name}/{path.relative_to(directory)}"] = path.read_bytes()
    files["manifest.json"] = json.dumps({
        "profile": profile_name,
        "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        "restore": "Import active-profile/author.p12 and distributor.p12 with their certificate passwords."
    }, indent=2).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue(), len(files)


def restore(data, destination):
    require_private_destination(destination)
    if destination.exists():
        raise SystemExit("Каталог восстановления уже существует. Укажите новый --output.")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        members = archive.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if not member.isfile() or Path(member.name).is_absolute() or ".." in parts:
                raise SystemExit("Недопустимый путь внутри архива.")
        files = {m.name: archive.extractfile(m).read() for m in members}
    manifest = json.loads(files["manifest.json"])
    if set(manifest["sha256"]) != set(files) - {"manifest.json"}:
        raise SystemExit("Состав архива не совпадает с манифестом.")
    for name, digest in manifest["sha256"].items():
        if hashlib.sha256(files[name]).hexdigest() != digest:
            raise SystemExit("Контрольная сумма архива не совпала.")
    destination.mkdir(mode=0o700, parents=True)
    for name, content in files.items():
        path = destination / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open("xb") as handle:
            os.chmod(path, 0o600)
            handle.write(content)
    print(f"Восстановлено файлов: {len(files)}. Каталог: {destination}")


def require_private_destination(destination):
    """Never write signing materials into the public source tree."""
    resolved = destination.expanduser().resolve()
    if resolved.is_relative_to(ROOT.resolve()) and not resolved.is_relative_to((ROOT / ".local").resolve()):
        raise SystemExit("Храните сертификаты и архив вне репозитория или в игнорируемом каталоге .local/.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "restore"])
    parser.add_argument("--password-gui", action="store_true", help="Ask for the archive password in a local window")
    parser.add_argument("--archive", type=Path, default=ARCHIVE)
    parser.add_argument("--output", type=Path, default=ROOT / ".local/certificates-restored")
    parser.add_argument("--profiles", type=Path, help="Your SDK data profile/profiles.xml; required for backup")
    parser.add_argument("--profile", default=PROFILE, help="Your existing Samsung certificate profile")
    parser.add_argument("--certificate-directory", type=Path, help="Optional certificate source directory; defaults to ~/SamsungCertificate/PROFILE")
    args = parser.parse_args()
    args.archive = args.archive.expanduser()
    args.output = args.output.expanduser()
    if args.action == "backup":
        if not args.profiles:
            parser.error("backup requires --profiles /path/to/tizen-studio-data/profile/profiles.xml")
        require_private_destination(args.archive)
        profiles = args.profiles.expanduser()
        directory = args.certificate_directory.expanduser() if args.certificate_directory else None
        try:
            plaintext, count = snapshot(profiles, args.profile, directory)
        except (OSError, ET.ParseError):
            raise SystemExit("Не удалось прочитать профиль или сертификаты. Проверьте --profiles и Certificate Manager.") from None
        secret = password(args.password_gui, confirm=True)
        encrypted = crypt(plaintext, secret)
        if crypt(encrypted, secret, decrypt=True) != plaintext:
            raise SystemExit("Проверка расшифровки не прошла; архив не сохранён.")
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=args.archive.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(encrypted)
        temporary.replace(args.archive)
        print(f"Зашифровано и проверено файлов: {count}. Архив: {args.archive}")
    else:
        encrypted = args.archive.read_bytes()
        secret = password(args.password_gui, confirm=False)
        restore(crypt(encrypted, secret, decrypt=True), args.output)


if __name__ == "__main__":
    main()
