import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { db } from "@devsync/db";

declare module "next-auth" {
  interface Session { userId?: string }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  pages: { signIn: "/" },
  session: { maxAge: 8 * 60 * 60 },
  callbacks: {
    async jwt({ token, account, user }) {
      if (account?.provider === "github") {
        const id = `github:${account.providerAccountId}`;
        const name = user.name ?? "GitHub user";
        await db.user.upsert({ where: { id }, create: { id, name }, update: { name } });
        token.sub = id;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.userId = token.sub;
      return session;
    },
  },
});
