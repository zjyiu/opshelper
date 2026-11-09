export function UserProfileName({ name, username }: { name: string; username: string }) {
  return (
    <>
      <span className="opshelper-user-avatar">
        {Array.from(name.trim() || username)[0]?.toUpperCase()}
      </span>
      <span className="opshelper-user-name">{name}</span>
    </>
  );
}
import React from "react";
