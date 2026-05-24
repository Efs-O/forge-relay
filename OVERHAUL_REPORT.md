# Vegoritis Series 9 ERP — Full Overhaul Assessment Report
**Date:** 2026-05-21
**Version analyzed:** 9.25.08.0 (x86 build, .NET Framework 4.x)
**Deployment path:** `C:\DWS Software (tm)\Vegoritis Suite\ERP\Bin\`

---

## 1. Current State Summary

The suite is operational after config-level fixes (BUG-01, BUG-03), but has structural problems that cannot be resolved without touching compiled code. The app runs, but under memory stress from the first minute.

| Item | Status |
|------|--------|
| BUG-01 CefSharp crash on launch | Fixed (app.config) |
| BUG-03 DirectX/skin menu crash | Fixed (app.config) |
| BUG-04 CefSharp GPU software rendering | Pending — needs source code |
| BUG-05 Registration | Pending — call DWS |
| SEC-01 Admin password = 1234 | Pending — change via app |
| 32-bit memory ceiling errors | Active — 3 popups on startup |
| Slowness | Active — caused by software rendering (BUG-04) |

---

## 2. Startup Error Analysis (4 Popups Observed on First Launch)

### Errors 1 & 4 — Root Cause: 32-bit Virtual Address Ceiling
```
HRESULT: 0x80070008 — Not enough memory resources
PresentationFramework could not be loaded
```
The process is **x86 (32-bit)**. Windows caps its virtual address space at ~2GB. At startup the app loads:
- CefSharp (Chromium engine) — ~300–500 MB alone
- DevExpress v22.1 — large UI framework
- 106 DWS.LIB.* assemblies
- Mixed WinForms + WPF

The ceiling is hit during initialization. WPF components fail to load because there is no address space left.

### Error 3 — GDI+ Effect #H.4
```
Σφάλμα Εφέ #H.4 — Η παράμετρος δεν είναι έγκυρη
```
A skin/rendering effect tried to draw to a Graphics object that was already disposed or had invalid dimensions. Downstream consequence of memory pressure.

### Error 2 — Index Out of Range (Purchases Module)
```
Vegoritis Series 9 - Διαχείριση Παραστατικών Αγορών
ArgumentOutOfRangeException: index = 0
```
The Purchase Documents UI grid tried to select item [0] from an empty or incompletely loaded collection. Bug in `DWS.LIB.Erp.Shopping.v.9` or consequence of memory pressure during load.

**All 4 errors are non-fatal** — the app continues after dismissing them.

---

## 3. Architecture Analysis

### 3.1 Main Executable

| Property | Value |
|----------|-------|
| File | `Vegoritis_Series9_Erp.exe` |
| Architecture | **x86 (32-bit)** — confirmed from PE header |
| Runtime | .NET Framework 4.x |
| Language | Visual Basic .NET |
| Version | 9.25.08.0 |
| UI frameworks | WinForms + WPF (mixed) |

### 3.2 DLL Inventory

| Category | Count |
|----------|-------|
| DWS.LIB.* custom modules | **106 DLLs** |
| DevExpress v22.1 UI framework | ~40 DLLs |
| CefSharp (Chromium browser) | 7 DLLs + native files |
| Third-party / unknown native | 4 DLLs |

---

## 4. Native DLL Risk Assessment (32-bit Blockers)

These four DLLs are compiled as x86 and cannot run in a 64-bit process without replacement.

### Voice.dll — CRITICAL
| Property | Value |
|----------|-------|
| Architecture | x86 32-bit |
| Version | 1.0.2270.28420 |
| Type | **Managed .NET assembly** — NOT unmanaged C++ |
| Purpose | Audio capture/playback — voice sounds throughout the app |
| Referenced by | **69 DWS.LIB DLLs + main EXE** |
| Risk | Highest — touches almost every module |
| Fix path | Recompile to AnyCPU (DWS provides source), OR decompile + recompile |
| Key fact | Being managed .NET means it CAN be decompiled and recompiled even without DWS |

### Winsock2007.DLL — LOW RISK
| Property | Value |
|----------|-------|
| Architecture | x86 32-bit |
| Version | 1.0.0.0 |
| Author | Kolkman Koding (open-source TCP library) |
| Type | Managed .NET assembly |
| Purpose | TCP/IP socket client — network/remote connectivity |
| Referenced by | 1 DLL only: `DWS.LIB.Network.NetSettings.v.9` |
| Fix path | Replace with built-in `System.Net.Sockets`, or recompile to AnyCPU |

### Direct.Library.dll — MEDIUM RISK
| Property | Value |
|----------|-------|
| Architecture | x86 32-bit |
| Version | 1.7841.1704.8912 |
| Author | "Dominator Legend" |
| Type | Managed .NET assembly |
| Purpose | VoIP / direct audio-video communication (Phone Center feature) |
| Referenced by | 1 DLL: `DWS.LIB.Utils.PhoneCenter.v.9` |
| Fix path | Decompile + recompile to AnyCPU, or replace with modern VoIP library |

### Apex.DLL — NO RISK
| Property | Value |
|----------|-------|
| Architecture | x86 32-bit |
| Referenced by | **0 DWS DLLs** |
| Action | Delete it — dead weight |

---

## 5. PowerPacks Assessment — LOW RISK

`Microsoft.VisualBasic.PowerPacks.Vs.dll` is a discontinued 32-bit-only Microsoft library (last updated 2010).

**Scan result: referenced by exactly 1 DLL:**
```
DWS.LIB.Office.CellBook.v.9.DLL  (spreadsheet/cell book module only)
```

**Verdict:** One non-core module. Invoices, customers, accounting, reports — all unaffected. The CellBook module would need its shape/layout controls replaced with modern equivalents, but this is contained work.

---

## 6. CefSharp GPU Issue (BUG-04) — Cause of Slowness

### Root Cause
CefSharp v107 (Chromium 107, Oct 2022) has a GPU blocklist that predates the RTX 5060 Ti (Blackwell, 2025) by 3 years. GPU is silently blacklisted → falls back to CPU software rendering → slowness on every page load.

Confirmed by `Bin\debug.log`:
```
[ERROR:gpu_init.cc(537)] Passthrough is not supported, GL is disabled, ANGLE is
```

### The Fix (6 lines — requires source code)
Find CefSharp initialization in `Vegoritis_Series9_Erp.exe` startup or `DWS.LIB.Core.StartUp.v.9`:

```vb
' CURRENT
Dim settings As New CefSharp.CefSettings()
Cef.Initialize(settings)

' FIXED
Dim settings As New CefSharp.CefSettings()
settings.CefCommandLineArgs.Add("use-angle", "d3d11")
settings.CefCommandLineArgs.Add("ignore-gpu-blocklist", "1")
settings.CefCommandLineArgs.Add("enable-gpu-rasterization", "1")
settings.CefCommandLineArgs.Add("enable-zero-copy", "1")
settings.LogFile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "vegoritis_cef.log")
settings.LogSeverity = CefSharp.LogSeverity.Warning
Cef.Initialize(settings)
```

---

## 7. Path to 64-bit Build

### What it actually means
The VB.NET managed code is platform-neutral. It runs as 32-bit only because the project was compiled with `Target CPU = x86`. Changing to `AnyCPU` and recompiling is the primary action — the .NET JIT handles the rest.

### Effort breakdown

| Task | Effort | Blocker? |
|------|--------|----------|
| Change EXE + all 106 DWS.LIB projects to AnyCPU | 1–2 hrs (scripted in VS) | No |
| Swap CefSharp x86 NuGet → x64 packages | 1 hr | No |
| Swap SQLite.Interop.dll → x64 | 15 min | No |
| Recompile Voice.dll to AnyCPU | 30 min (if DWS provides source) | Only if DWS refuses |
| Recompile Winsock2007 or replace | 1 hr | No |
| Recompile Direct.Library or replace | 2–4 hrs | No |
| Fix PowerPacks in CellBook module | 4–8 hrs | No |
| **Total — DWS provides Voice.dll source** | **1–2 days** | — |
| **Total — DWS refuses, decompile Voice.dll** | **2–3 days** | — |

---

## 8. Decompilation Plan (Automated)

### Why it is feasible
- DLLs are **not obfuscated** — confirmed by readable class/method names throughout
- All problematic DLLs are managed .NET — IL is fully recoverable
- 106 DLLs can be decompiled in ~10–15 minutes with the automation below

### Run the full decompile (when ready)

```powershell
$bin = "C:\DWS Software (tm)\Vegoritis Suite\ERP\Bin"
$out = "C:\DWS_Decompiled"
$targets  = Get-ChildItem "$bin\DWS.LIB.*.dll"
$targets += Get-Item "$bin\Vegoritis_Series9_Erp.exe"
$targets += Get-Item "$bin\Voice.dll"
$targets += Get-Item "$bin\Winsock2007.DLL"
$targets += Get-Item "$bin\Direct.Library.dll"
foreach ($t in $targets) {
    & "C:\Tools\VegDecompile\publish\VegDecompile.exe" $t.FullName (Join-Path $out $t.BaseName)
}
```

### Output structure
```
C:\DWS_Decompiled\
  Vegoritis_Series9_Erp\       <- main app, CefSharp init (BUG-04 fix location)
  DWS.LIB.Erp.Invoices.v.9\   <- invoice module
  DWS.LIB.Erp.Shopping.v.9\   <- purchases module (Error 2 fix location)
  DWS.LIB.Core.StartUp.v.9\   <- startup sequence
  Voice\                       <- audio library
  Winsock2007\                 <- network library
  Direct.Library\              <- VoIP library
  ... (106 more folders)
```

### What you get vs. what you don't

| Item | Result |
|------|--------|
| Readable C# source files | Yes — not obfuscated |
| Immediately buildable solution | No — .csproj/.sln need wiring, DevExpress license required |
| Targeted single-DLL fixes | Yes — decompile one DLL, fix it, recompile just that DLL |
| Voice.dll recompiled as 64-bit | Yes |

---

## 9. What to Ask DWS Software

Send this document. Ask in writing:

1. **"Provide a 64-bit (AnyCPU) build."** — Same codebase, one recompile, ~1 day of developer work.
2. **"Apply the CefSharp GPU fix."** — 6-line change. Exact code is in Section 6 and in `GPU_FIX_DEVELOPER_HANDOFF.md`.
3. **"Provide source or 64-bit build of Voice.dll."** — Referenced by 69 modules, the single biggest blocker.
4. **"Fix the Purchases module index crash."** — `DWS.LIB.Erp.Shopping.v.9`, ArgumentOutOfRangeException on index 0.
5. **"What is your roadmap for a 64-bit release?"** — If they have none, that answers the question of whether self-service is the only path.

---

## 10. Quick Win — No Source Code Needed (LARGEADDRESSAWARE Patch)

A 1-bit change to the EXE's PE header tells Windows to give the 32-bit process **4GB** of virtual address space instead of 2GB. This will likely eliminate Errors 1, 3, and 4 immediately. Takes 5 minutes, fully reversible.

```powershell
# Backup first
Copy-Item "C:\DWS Software (tm)\Vegoritis Suite\ERP\Bin\Vegoritis_Series9_Erp.exe" `
          "C:\DWS Software (tm)\Vegoritis Suite\ERP\Bin\Vegoritis_Series9_Erp.exe.bak"

# Apply patch
$path  = "C:\DWS Software (tm)\Vegoritis Suite\ERP\Bin\Vegoritis_Series9_Erp.exe"
$bytes = [System.IO.File]::ReadAllBytes($path)
$peOffset    = [BitConverter]::ToInt32($bytes, 0x3C)
$charOffset  = $peOffset + 0x16
$current     = [BitConverter]::ToUInt16($bytes, $charOffset)
$patched     = [uint16]($current -bor 0x0020)
$bytes[$charOffset]     = [byte]($patched -band 0xFF)
$bytes[$charOffset + 1] = [byte]($patched -shr 8)
[System.IO.File]::WriteAllBytes($path, $bytes)
Write-Host "Done. Relaunch via EXE to test."
```

---

## 11. Recommended Sequence

```
Step 1 (30 min, no source needed):  Apply LARGEADDRESSAWARE patch → relaunch → confirm errors 1/3/4 gone
Step 2 (do now regardless):         Change admin password SEC-01 via the app
Step 3 (this week):                 Contact DWS with this document
Step 4a (if DWS cooperates):        Test their 64-bit build + GPU fix → deploy
Step 4b (if DWS refuses):           Run decompile automation → engage .NET developer
```

---

## 12. Tools Installed — Ready for Implementation

All tools are installed and verified working. No further setup needed before the impl plan.

| Tool | Path | Purpose |
|------|------|---------|
| ILSpy GUI v10.0.1 | `C:\Tools\ILSpy\ILSpy.exe` | Visual DLL browser — open any DLL and read source interactively |
| ILSpy binaries v10.0.1 | `C:\Tools\ILSpy\binaries\ILSpy.exe` | Full toolkit |
| VegDecompile.exe (custom CLI) | `C:\Tools\VegDecompile\publish\VegDecompile.exe` | Batch decompiler — runs the automation script in Section 8 |
| ICSharpCode.Decompiler v8.2.0.7535 | Embedded in VegDecompile | Core decompiler engine (same engine as ILSpy) |
| .NET 8 SDK v8.0.421 | System global | Runtime — already installed |
| nuget.org source | .NET global config | Configured for future package installs |

*Verification: VegDecompile was tested against `DWS.LIB.Core.StartUp.v.9.dll` and produced clean C# source files successfully.*
