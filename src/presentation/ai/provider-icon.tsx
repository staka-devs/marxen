import { Plug } from "lucide-react";
import type { AiProviderId } from "../../contracts/ai-view-preferences";

/** Recognizable monochrome provider marks remain legible in every theme. */
export function ProviderIcon({ provider, size = 16 }: { provider: AiProviderId; size?: number }) {
  if (provider === "copilot") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-provider-icon={provider}><path d="M12 .8A11.2 11.2 0 0 0 8.5 22.6c.6.1.8-.3.8-.5v-2c-3.1.7-3.8-1.3-3.8-1.3-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.7 2.6 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.5-.3-5.1-1.2-5.1-5.5 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.4.1-3 0 0 .9-.3 3.1 1.1a10.7 10.7 0 0 1 5.6 0c2.1-1.4 3.1-1.1 3.1-1.1.6 1.6.2 2.7.1 3 .7.8 1.1 1.8 1.1 3 0 4.3-2.6 5.2-5.1 5.5.4.3.8 1 .8 2.1v3c0 .3.2.6.8.5A11.2 11.2 0 0 0 12 .8Z" /></svg>;
  if (provider === "custom") return <Plug size={size} aria-hidden="true" data-provider-icon={provider} />;
  if (provider === "opencode") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-provider-icon={provider}><path fillRule="evenodd" d="M4 3h16v18H4Zm4 4v10h8V7Z" /><path d="M8 13h8v4H8Z" opacity=".45" /></svg>;
  if (provider === "anthropic" || provider === "claude_code") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-provider-icon={provider}><path d="m5 19 6-14h3l6 14h-3.3l-1.2-3H9.4l-1.2 3Zm5.5-5.6h3.9l-2-5.1ZM19 5h2v14h-2Z" /></svg>;
  if (provider === "openai_chat_completions" || provider === "openai_responses") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" data-provider-icon={provider}>{[0, 60, 120, 180, 240, 300].map((angle) => <path key={angle} transform={`rotate(${angle} 12 12)`} d="M12 3a5 5 0 0 1 4.3 7.5L12 13l-4.3-2.5V5.5Z" />)}</svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-provider-icon={provider}><rect x="2" y="3" width="20" height="18" rx="4" /><path d="m7 8 4 4-4 4m7 0h4" /></svg>;
}
