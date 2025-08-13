import supervisor
import storage

storage.remount("/", readonly=False)

m = storage.getmount("/")
m.label = "SANDBOX-FV1"

storage.remount("/", readonly=True)

storage.enable_usb_drive()

supervisor.set_usb_identification(manufacturer='Disaster Area Designs', product='SandboxFV1', vid=0xBEEF, pid=0xB00B)

print("[SUCCESS] Sandbox-FV1 Boot")