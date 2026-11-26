"""Create a deterministic ZIP from a directory (fixed timestamps, sorted entries)."""

import os
import sys
import zipfile

source, destination = sys.argv[1], sys.argv[2]
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def main() -> None:
    os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for root, directories, files in os.walk(source):
            directories.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                relative = os.path.relpath(full, source).replace(os.sep, "/")
                info = zipfile.ZipInfo(relative, date_time=FIXED_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                with open(full, "rb") as handle:
                    archive.writestr(info, handle.read())
    print(destination)


if __name__ == "__main__":
    main()
