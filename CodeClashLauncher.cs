using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;
internal class CodeClashLauncher
{
    static int Main(string[] args)
    {
        try
        {
            string install=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClaudeClashGuardian");
            string exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Microsoft VS Code","Code.exe");
            string script=Path.Combine(install,"launcher.cjs");
            ProcessStartInfo start=new ProcessStartInfo(exe,Quote(script)+" "+string.Join(" ",args.Select(Quote).ToArray()));
            start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardError=true;
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1";
            start.EnvironmentVariables["CLAUDE_GUARD_CODE_EXE"]=exe;
            using(Process child=Process.Start(start))
            {
                string error=child.StandardError.ReadToEnd();child.WaitForExit();
                if(child.ExitCode!=0)MessageBox.Show(error,"Claude 保护启动器",MessageBoxButtons.OK,MessageBoxIcon.Error);
                return child.ExitCode;
            }
        }
        catch(Exception e){MessageBox.Show(e.Message,"Claude 保护启动器",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
    }
    static string Quote(string arg)
    {
        if(arg.Length>0&&!arg.Any(c=>char.IsWhiteSpace(c)||c=='"'))return arg;
        StringBuilder result=new StringBuilder("\"");int slashes=0;
        foreach(char c in arg){if(c=='\\'){slashes++;continue;}if(c=='"')result.Append('\\',slashes*2+1).Append('"');else result.Append('\\',slashes).Append(c);slashes=0;}
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
}
