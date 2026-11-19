import { ChatView } from "../chat/ChatView.tsx";

/** Ask the brain a question; the route parameter is the open conversation. */
export function AskPage({ threadId }: { threadId: string | null }) {
  return <ChatView threadId={threadId} />;
}
