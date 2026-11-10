import { corsPreflight, handleChat } from "@/server/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleChat(req, "openai");
export const OPTIONS = () => corsPreflight();
