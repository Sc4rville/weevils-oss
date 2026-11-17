/** A finished job's last line that says it failed: ✗, npm ERR!, a non-zero exit, error / failed / fatal… (not « 0 errors »). */
const FAIL =
  /[✗✘❌]|\bERR!|\bexit(?:ed)?(?: with)?(?: (?:code|status))?\s*[:=]?\s*[1-9]\d*|\bnon-?zero exit|(?<!\b(?:0|no|zero)\s+)\b(?:errors?|fail(?:ed|s|ures?)?|fatal|panic|traceback|abort(?:ed)?)\b(?!\s*[:=]?\s*0\b)/i

export const failedLine = (line: string | undefined): boolean => !!line && FAIL.test(line)
