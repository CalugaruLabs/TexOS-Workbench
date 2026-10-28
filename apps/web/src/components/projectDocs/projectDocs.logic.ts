import type { ProjectDocAuthor } from "@t3tools/contracts";

export function projectDocAuthorLabel(author: ProjectDocAuthor): string {
  switch (author._tag) {
    case "User":
      return "Edited by you";
    case "Agent":
      return "Edited by an agent";
    case "Client":
      return `Edited by ${author.label}`;
  }
}
