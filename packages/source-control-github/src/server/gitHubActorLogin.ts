/** GitHub's actor records can omit the suffix present on an App's authenticated login. */
export function gitHubActorLogin(login: string, isBot: boolean): string {
  const normalized = login.toLowerCase();
  return isBot && !normalized.endsWith("[bot]") ? `${normalized}[bot]` : normalized;
}
