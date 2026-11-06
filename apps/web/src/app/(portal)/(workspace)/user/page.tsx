import { redirect } from "next/navigation";

export default function UserSettingsPage(): never {
  redirect("/chat");
}
