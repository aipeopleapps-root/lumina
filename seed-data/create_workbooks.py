from workbook_gen import generate_absence_config_workbook, generate_hcm_config_workbook
from pathlib import Path

# Generate workbooks (these return bytes)
absence_data = generate_absence_config_workbook("Acme Corp")
hcm_data = generate_hcm_config_workbook("Acme Corp")

# Write to files
absence_path = Path.home() / "Documents" / "Acme_Corp_Absence_Config.xlsx"
hcm_path = Path.home() / "Documents" / "Acme_Corp_HCM_Config.xlsx"

with open(absence_path, "wb") as f:
    f.write(absence_data)
print(f"✅ Created: {absence_path}")

with open(hcm_path, "wb") as f:
    f.write(hcm_data)
print(f"✅ Created: {hcm_path}")

print(f"\n📁 Files are in your Documents folder")
