"""Build synthetic transport fixtures. These contain no research code or results."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_STORED

ROOT = Path(__file__).resolve().parent
for filename, experiment, launcher in [
    ("source.zip", "h204_fixture", "launch_h204.py"),
    ("h219-source.zip", "v527_h219_smolvlm_mlpq_precision_pope300_hr800", "launch_h219.py"),
]:
    with ZipFile(ROOT / filename, "w", ZIP_STORED) as archive:
        members = {launcher: b"# Synthetic ZIP parsing fixture; never a scientific experiment.\n"}
        members.update({f"fixture_{index}.txt": b"synthetic fixture\n" for index in range(6)})
        for name, content in members.items():
            archive.writestr(ZipInfo(f"route/hypotheses/{experiment}/{name}"), content)
print("Generated two synthetic ZIP fixtures")
