param(
  [Parameter(Mandatory = $true)]
  [string]$LinkPath
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true') {
  throw 'Shortcut inspection is restricted to the ephemeral GitHub Windows runner.'
}

if (!('QiyeShortcutInspection.NativeReader' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace QiyeShortcutInspection {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FindData {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
      WriteLow, WriteHigh, SizeHigh, SizeLow, Reserved0, Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string FileName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateName;
  }
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out FindData data, uint flags);
    [PreserveSig] int GetIDList(out IntPtr idList);
    [PreserveSig] int SetIDList(IntPtr idList);
    [PreserveSig] int GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    [PreserveSig] int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    [PreserveSig] int GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    [PreserveSig] int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    [PreserveSig] int GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    [PreserveSig] int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    [PreserveSig] int GetHotkey(out ushort value);
    [PreserveSig] int SetHotkey(ushort value);
    [PreserveSig] int GetShowCmd(out int value);
    [PreserveSig] int SetShowCmd(int value);
    [PreserveSig] int GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, out int index);
    [PreserveSig] int SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
    [PreserveSig] int SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
    [PreserveSig] int Resolve(IntPtr owner, uint flags);
    [PreserveSig] int SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
  }
  [ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile {
    [PreserveSig] int GetClassID(out Guid value);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string path, uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string path, bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string path);
    [PreserveSig] int GetCurrentFile([MarshalAs(UnmanagedType.LPWStr)] out string path);
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PropertyKey { public Guid Format; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PropertyVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint value);
    [PreserveSig] int GetAt(uint index, out PropertyKey value);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropertyVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyVariant value);
    [PreserveSig] int Commit();
  }
  public static class NativeReader {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetNameFromIDList(IntPtr list, uint type, out IntPtr name);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropertyVariant value);
    static string Status(int value) { return "0x" + unchecked((uint)value).ToString("X8"); }
    public static Dictionary<string, object> Read(string filename) {
      var result = new Dictionary<string, object>();
      object instance = null;
      try {
        instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"), true));
        var persist = (IPersistFile)instance;
        int loaded = persist.Load(filename, 0);
        result["loadHRESULT"] = Status(loaded);
        if (loaded < 0) throw new COMException("IPersistFile.Load failed", loaded);
        var link = (IShellLinkW)instance;
        FindData data;
        var target = new StringBuilder(32768);
        result["getPathHRESULT"] = Status(link.GetPath(target, target.Capacity, out data, 0));
        result["target"] = target.ToString();
        var raw = new StringBuilder(32768);
        result["getRawPathHRESULT"] = Status(link.GetPath(raw, raw.Capacity, out data, 4));
        result["rawTarget"] = raw.ToString();
        var icon = new StringBuilder(32768);
        int iconIndex;
        result["getIconHRESULT"] = Status(link.GetIconLocation(icon, icon.Capacity, out iconIndex));
        result["iconPath"] = icon.ToString(); result["iconIndex"] = iconIndex;
        IntPtr list;
        int listStatus = link.GetIDList(out list);
        result["getIdListHRESULT"] = Status(listStatus);
        if (list != IntPtr.Zero) {
          try {
            IntPtr name;
            int nameStatus = SHGetNameFromIDList(list, 0x80028000, out name);
            result["getIdListNameHRESULT"] = Status(nameStatus);
            if (name != IntPtr.Zero) {
              try { result["idListTarget"] = Marshal.PtrToStringUni(name); }
              finally { Marshal.FreeCoTaskMem(name); }
            }
          } finally { Marshal.FreeCoTaskMem(list); }
        }
        try {
          var store = (IPropertyStore)instance;
          var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
          PropertyVariant value;
          int propertyStatus = store.GetValue(ref key, out value);
          result["getAppIdHRESULT"] = Status(propertyStatus);
          try {
            result["appIdVariantType"] = value.Type;
            if (propertyStatus >= 0 && value.Type == 31) result["appId"] = Marshal.PtrToStringUni(value.Pointer);
            else if (propertyStatus >= 0 && value.Type == 8) result["appId"] = Marshal.PtrToStringBSTR(value.Pointer);
          } finally { PropVariantClear(ref value); }
        } catch (Exception error) { result["appIdError"] = error.Message; result["appIdErrorHRESULT"] = Status(error.HResult); }
      } catch (Exception error) {
        result["error"] = error.Message; result["errorHRESULT"] = Status(error.HResult);
      } finally { if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance); }
      return result;
    }
  }
}
'@
}

$resolved = (Resolve-Path -LiteralPath $LinkPath).Path
$file = Get-Item -LiteralPath $resolved
$bytes = [IO.File]::ReadAllBytes($resolved)
$flags = if ($bytes.Length -ge 24) { [BitConverter]::ToUInt32($bytes, 20) } else { $null }
$flagNames = @{
  HasLinkTargetIDList = 0x1; HasLinkInfo = 0x2; HasName = 0x4; HasRelativePath = 0x8;
  HasWorkingDir = 0x10; HasArguments = 0x20; HasIconLocation = 0x40; IsUnicode = 0x80
}
$setFlags = @($flagNames.GetEnumerator() | Where-Object { $null -ne $flags -and ($flags -band $_.Value) -ne 0 } | ForEach-Object { $_.Key } | Sort-Object)
# Read-only binary evidence from this test-created shortcut, never user account files.
$unicodeStrings = @()
for ($alignment = 0; $alignment -le 1; $alignment++) {
  $length = $bytes.Length - $alignment
  $length -= $length % 2
  if ($length -gt 0) {
    $text = [Text.Encoding]::Unicode.GetString($bytes, $alignment, $length)
    $unicodeStrings += @([regex]::Matches($text, '[\p{L}\p{N}:\\/ ._~(){}%-]{5,}') | ForEach-Object { $_.Value } |
      Where-Object { $_ -match '(?:[A-Za-z]:\\|栖页|\.exe|com\.qiye\.browser)' } | Select-Object -First 12)
  }
}
$report = [ordered]@{
  link = $resolved; length = $bytes.Length; attributes = $file.Attributes.ToString();
  headerSize = if ($bytes.Length -ge 4) { [BitConverter]::ToUInt32($bytes, 0) } else { $null };
  shellLinkCLSID = if ($bytes.Length -ge 20) { [Guid]::new([byte[]]$bytes[4..19]).ToString() } else { $null };
  headerFlags = $flags; flagNames = $setFlags;
  headerIconIndex = if ($bytes.Length -ge 60) { [BitConverter]::ToInt32($bytes, 56) } else { $null };
  utf16Strings = @($unicodeStrings | Select-Object -Unique | Select-Object -First 16);
  native = [QiyeShortcutInspection.NativeReader]::Read($resolved)
}
if ($bytes.Length -le 8192) { $report['rawShortcutBase64'] = [Convert]::ToBase64String($bytes) }
else { $report['rawShortcutBase64'] = 'omitted: shortcut exceeds 8 KB' }
[PSCustomObject]$report
