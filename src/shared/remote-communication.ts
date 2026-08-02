export function shouldSendTyping(state: string | undefined, teamActive: boolean): boolean {
  if (state === "awaiting-input") return false;
  return state === "thinking" || state === "tool" || teamActive;
}

export function shouldRelayUnsolicitedNotice(teamActive: boolean): boolean {
  return !teamActive;
}
