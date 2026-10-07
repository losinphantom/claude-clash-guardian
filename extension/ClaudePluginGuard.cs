using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

internal static class ClaudePluginGuard
{
    static readonly string Install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudePluginGuard");
    static readonly string Verge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "io.github.clash-verge-rev.clash-verge-rev", "verge.yaml");
    static readonly string Core = Path.Combine(Path.GetDirectoryName(Verge), "config.yaml");
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--watch-state")
            {
                int parentId;
                if (!int.TryParse(args[1], out parentId)) return 77;
                using (Process parent = Process.GetProcessById(parentId))
                {
                    DateTime started = parent.StartTime;
                    while (true)
                    {
                        if (parent.HasExited || parent.StartTime != started) return 0;
                        Console.WriteLine("{\"allowed\":" + (IsAllowed() ? "true" : "false") + ",\"port\":" + ReadPort() + "}");
                        Console.Out.Flush();
                        System.Threading.Thread.Sleep(100);
                    }
                }
            }
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            if (args.Length == 1 && args[0] == "--guard-status")
            {
                Console.WriteLine("proxy_switch_allows_run=" + IsAllowed());
                Console.WriteLine("upstream_port=" + ReadPort());
                return 0;
            }
            if (args.Length < 1 || !Approved(args[0]))
                return Fail("Only the official installed VS Code Claude binary can run through this guardian.");
            if (!IsAllowed()) return Fail("Clash system proxy and TUN are both off or unavailable. Claude was not started.");
            int port = ReadPort();
            if (port < 1) return Fail("Clash HTTP/mixed proxy port is unavailable.");

            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail("Cannot create process containment job.");
            try
            {
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                    return Fail("Cannot configure process containment job.");
                ProcessStartInfo start = new ProcessStartInfo(Path.GetFullPath(args[0]), string.Join(" ", args.Skip(1).Select(Quote).ToArray()));
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                string proxy = "http://127.0.0.1:" + port;
                foreach (string key in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy" })
                    start.EnvironmentVariables.Remove(key);
                start.EnvironmentVariables["HTTPS_PROXY"] = proxy;
                start.EnvironmentVariables["HTTP_PROXY"] = proxy;
                start.EnvironmentVariables["NO_PROXY"] = "localhost,127.0.0.1,::1";
                start.EnvironmentVariables["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
                start.EnvironmentVariables["DISABLE_TELEMETRY"] = "1";
                start.EnvironmentVariables["DISABLE_ERROR_REPORTING"] = "1";
                string privacy = Environment.GetEnvironmentVariable("CLAUDE_GUARD_PRIVACY_JSON");
                if (!string.IsNullOrEmpty(privacy))
                {
                    string preload = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "backend-privacy.cjs");
                    if (!File.Exists(preload)) return Fail("Privacy preload is missing. Claude was not started.");
                    string preloadArgument = PreloadArgument(preload);
                    if (preloadArgument == null) return Fail("Privacy preload path cannot be passed to this Bun runtime. Claude was not started.");
                    string extra = "--preload=" + preloadArgument;
                    start.EnvironmentVariables["BUN_OPTIONS"] = (start.EnvironmentVariables["BUN_OPTIONS"] ?? "") + " " + extra;
                    start.EnvironmentVariables.Remove("BUN_BE_BUN");
                    // Verify that this installed Bun executable runs our preload
                    // before its entry point. The probe exits before Claude starts.
                    if (!PrivacyProbe(start)) return Fail("Claude privacy preload is unsupported or failed validation. Claude was not started.");
                    if (!IsAllowed() || ReadPort() != port) return Fail("Clash changed while validating privacy. Claude was not started.");
                }
                using (Process child = Process.Start(start))
                {
                    if (child == null) return Fail("Cannot launch Claude.");
                    if (!AssignProcessToJobObject(job, child.Handle))
                    {
                        if (!child.HasExited) child.Kill();
                        return Fail("Cannot contain Claude and its child processes.");
                    }
                    Task input = Task.Factory.StartNew(() => { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); try { child.StandardInput.Close(); } catch { } }, TaskCreationOptions.LongRunning);
                    Task output = Task.Factory.StartNew(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()), TaskCreationOptions.LongRunning);
                    Task error = Task.Factory.StartNew(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()), TaskCreationOptions.LongRunning);
                    while (!child.WaitForExit(100))
                    {
                        if (!IsAllowed() || ReadPort() != port)
                        {
                            TerminateJobObject(job, 77);
                            child.WaitForExit();
                            Task.WaitAll(new[] { output, error }, 2000);
                            return Fail("Clash proxy was disabled or its port changed. Claude and its child processes were stopped.");
                        }
                    }
                    // Stop descendants before draining pipes they may have inherited.
                    TerminateJobObject(job, 0);
                    Task.WaitAll(new[] { output, error }, 2000);
                    return child.ExitCode;
                }
            }
            finally { CloseHandle(job); }
        }
        catch (Exception e) { return Fail(e.GetType().Name + ": " + e.Message); }
    }
    static int Fail(string message) { Console.Error.WriteLine("[ClaudePluginGuard] " + message); return 77; }
    static void Pump(Stream source, Stream destination)
    {
        try
        {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = source.Read(buffer, 0, buffer.Length)) > 0) { destination.Write(buffer, 0, count); destination.Flush(); }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }
    static bool PrivacyProbe(ProcessStartInfo prepared)
    {
        try
        {
            ProcessStartInfo probe = new ProcessStartInfo(prepared.FileName, "--version");
            probe.UseShellExecute=false;probe.CreateNoWindow=true;probe.RedirectStandardOutput=true;probe.RedirectStandardError=true;
            probe.EnvironmentVariables.Clear();
            foreach (string key in prepared.EnvironmentVariables.Keys) probe.EnvironmentVariables[key]=prepared.EnvironmentVariables[key];
            probe.EnvironmentVariables["CLAUDE_GUARD_PRIVACY_PROBE"]="1";
            using (Process child=Process.Start(probe))
            {
                Task<string> output=child.StandardOutput.ReadToEndAsync(),error=child.StandardError.ReadToEndAsync();
                if (!child.WaitForExit(5000)) {child.Kill();return false;}
                return child.ExitCode==0 && output.Result.Trim()=="CLAUDE_GUARD_PRIVACY_READY";
            }
        }
        catch {return false;}
    }
    static string PreloadArgument(string path)
    {
        // This Bun version treats quotes in BUN_OPTIONS as literal characters.
        // Prefer the existing file's Windows short path if whitespace is present.
        if (path.Any(char.IsWhiteSpace))
        {
            StringBuilder buffer=new StringBuilder(32768);
            uint length=GetShortPathName(path,buffer,(uint)buffer.Capacity);
            if (length==0 || length>=buffer.Capacity || buffer.ToString().Any(char.IsWhiteSpace)) return null;
            path=buffer.ToString();
        }
        return path.Replace('\\','/');
    }
    internal static bool YamlTrue(string text, string key)
    {
        return Regex.IsMatch(text, "(?m)^" + Regex.Escape(key) + @":\s*true\s*(?:#.*)?\r?$", RegexOptions.IgnoreCase);
    }
    internal static bool Gate(bool systemFlag, bool actualSystemProxy, bool tunFlag, bool actualTun)
    { return (systemFlag && actualSystemProxy) || (tunFlag && actualTun); }
    static bool IsAllowed()
    {
        try
        {
            string text = File.ReadAllText(Verge);
            int port = ReadPort();
            if (port < 1) return false;
            bool actualSystem = false;
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings"))
            {
                if (key != null)
                {
                    string server = Convert.ToString(key.GetValue("ProxyServer", ""));
                    actualSystem = Convert.ToInt32(key.GetValue("ProxyEnable", 0)) == 1 &&
                        Regex.IsMatch(server, @"(?:^|[=;])(?:127\.0\.0\.1|localhost):" + port + @"(?:$|;)", RegexOptions.IgnoreCase);
                }
            }
            bool actualTun = NetworkInterface.GetAllNetworkInterfaces().Any(n =>
                (n.Name.Equals("Mihomo", StringComparison.OrdinalIgnoreCase) || n.Description.IndexOf("Meta Tunnel", StringComparison.OrdinalIgnoreCase) >= 0) &&
                n.OperationalStatus == OperationalStatus.Up);
            return Gate(YamlTrue(text, "enable_system_proxy"), actualSystem, YamlTrue(text, "enable_tun_mode"), actualTun);
        }
        catch { return false; }
    }
    static int ReadPort()
    {
        try
        {
            string text = File.ReadAllText(Core);
            foreach (string key in new[] { "mixed-port", "port" })
            {
                Match match = Regex.Match(text, "(?m)^" + key + @":\s*(\d+)\s*(?:#.*)?\r?$");
                int port;
                if (match.Success && int.TryParse(match.Groups[1].Value, out port) && port > 0 && port <= 65535) return port;
            }
        }
        catch { }
        return -1;
    }
    static bool Approved(string path)
    {
        try
        {
            path=Path.GetFullPath(path);
            string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".vscode", "extensions") + Path.DirectorySeparatorChar;
            return path.StartsWith(root,StringComparison.OrdinalIgnoreCase) && File.Exists(path) &&
                Regex.IsMatch(path, @"\\anthropic\.claude-code-[^\\]+\\resources\\(?:native-binary|native-binaries\\[^\\]+)\\claude\.exe$",RegexOptions.IgnoreCase);
        }
        catch{return false;}
    }
    internal static string Quote(string arg)
    {
        if (arg.Length > 0 && !arg.Any(c => char.IsWhiteSpace(c) || c == '"')) return arg;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static int SelfTest()
    {
        for (int mask = 0; mask < 16; mask++)
        {
            bool a = (mask & 1) != 0, b = (mask & 2) != 0, c = (mask & 4) != 0, d = (mask & 8) != 0;
            if (Gate(a,b,c,d) != ((a && b) || (c && d))) throw new Exception("Gate truth table failed.");
        }
        if (YamlTrue("enable_tun_mode: false\n", "enable_tun_mode") || !YamlTrue("enable_tun_mode: true\r\n", "enable_tun_mode") || YamlTrue("  enable_tun_mode: true\n", "enable_tun_mode")) throw new Exception("Flag parsing failed.");
        if (Quote("") != "\"\"" || Quote("hello world") != "\"hello world\"" || Quote("abc") != "abc") throw new Exception("Argument quoting failed.");
        Console.WriteLine("PASS: 16 gate states, flag parsing, argument quoting.");
        return 0;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetShortPathName(string longPath,StringBuilder shortPath,uint capacity);
}
