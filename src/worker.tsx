import { render, route } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { Home } from "@/app/pages/home";
import { chatHandler } from "@/app/api/chat";
import {
  listConversations,
  saveConversation,
  getConversation,
  deleteConversation,
} from "@/app/api/history";

export type AppContext = {};

export default defineApp([
  setCommonHeaders(),
  route("/api/chat", { post: chatHandler }),
  route("/api/history", { get: listConversations, post: saveConversation }),
  route("/api/history/:id", { get: getConversation, delete: deleteConversation }),
  render(Document, [route("/", Home)]),
]);
