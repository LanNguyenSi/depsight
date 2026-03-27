import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { prisma } from './prisma';

interface GitHubProfile {
  id: number;
  login: string;
  email?: string;
  avatar_url?: string;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: 'repo user:email read:org',
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!account || !profile) return false;

      const githubProfile = profile as unknown as GitHubProfile;

      try {
        await prisma.user.upsert({
          where: { githubId: String(githubProfile.id) },
          update: {
            email: user.email ?? null,
            githubLogin: githubProfile.login,
            githubToken: account.access_token ?? '',
            avatarUrl: user.image ?? null,
            updatedAt: new Date(),
          },
          create: {
            githubId: String(githubProfile.id),
            email: user.email ?? null,
            githubLogin: githubProfile.login,
            githubToken: account.access_token ?? '',
            avatarUrl: user.image ?? null,
          },
        });

        return true;
      } catch (error) {
        console.error('Error saving user:', error);
        return false;
      }
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { githubId: token.sub },
          select: { id: true, githubLogin: true, githubToken: true },
        });

        if (dbUser) {
          session.user.id = dbUser.id;
          session.user.githubLogin = dbUser.githubLogin;
          session.user.githubToken = dbUser.githubToken;
        }
      }
      return session;
    },
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.sub = String((profile as unknown as GitHubProfile).id);
      }
      return token;
    },
  },
  pages: {
    signIn: '/login',
  },
});
