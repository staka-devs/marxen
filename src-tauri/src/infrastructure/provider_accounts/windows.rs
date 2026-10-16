//! Windows private account homes use a protected, verified current-user ACL.
use crate::contracts::provider_accounts::ProviderAccountError;
use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// Grant only the current user access, including files created below this directory.
pub(super) fn private_directory(path: &Path) -> Result<(), ProviderAccountError> {
    use std::os::windows::process::CommandExt;
    // The script is constant; the path crosses the process boundary only as environment data.
    let script = r#"
$ErrorActionPreference = 'Stop'
$accountPath = $env:MARXEN_PRIVATE_DIRECTORY
$accountSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$accountAcl = New-Object System.Security.AccessControl.DirectorySecurity
$accountAcl.SetOwner($accountSid)
$accountAcl.SetAccessRuleProtection($true, $false)
$accountRule = New-Object System.Security.AccessControl.FileSystemAccessRule($accountSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$accountAcl.AddAccessRule($accountRule)
Set-Acl -LiteralPath $accountPath -AclObject $accountAcl
$verifiedAcl = Get-Acl -LiteralPath $accountPath
$verifiedRules = @($verifiedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $verifiedAcl.AreAccessRulesProtected -or $verifiedAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $accountSid.Value -or $verifiedRules.Count -ne 1 -or $verifiedRules[0].IdentityReference.Value -ne $accountSid.Value -or $verifiedRules[0].AccessControlType -ne 'Allow' -or ($verifiedRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Invalid private directory ACL' }
"#;
    let system_root = std::env::var_os("SystemRoot").ok_or(ProviderAccountError::StoreFailed)?;
    let mut child = Command::new(
        Path::new(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    )
    .args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ])
    .env("MARXEN_PRIVATE_DIRECTORY", path)
    .creation_flags(0x0800_0000)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|_| ProviderAccountError::StoreFailed)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(ProviderAccountError::StoreFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Verify the real Windows ACL path also accepts Unicode and shell metacharacters as data.
    #[test]
    fn private_home_acl_is_verified_without_path_interpolation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("認証 [private] ' $(throw).dir");
        std::fs::create_dir(&path).unwrap();
        private_directory(&path).unwrap();
        let auth = path.join("auth.json");
        std::fs::write(&auth, b"{}").unwrap();
        let verified = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", r#"
$ErrorActionPreference = 'Stop'
$accountSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @((Get-Acl -LiteralPath $env:MARXEN_PRIVATE_FILE).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $accountSid -or $rules[0].AccessControlType -ne 'Allow') { exit 1 }
"#])
            .env("MARXEN_PRIVATE_FILE", auth)
            .status().unwrap();
        assert!(verified.success());
        private_directory(&path).unwrap();
        assert_eq!(std::fs::read(path.join("auth.json")).unwrap(), b"{}");
    }
}
