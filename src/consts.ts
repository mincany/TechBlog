import type { Site, Metadata, Socials } from "@types";

export const SITE: Site = {
  NAME: "Mincan Yang",
  EMAIL: "mincan.yang@outlook.com",
  NUM_POSTS_ON_HOMEPAGE: 3,
  NUM_WORKS_ON_HOMEPAGE: 3,
  NUM_PROJECTS_ON_HOMEPAGE: 0,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION: "Engineer building compute capacity systems. Writing about distributed systems, AI infrastructure, and GPU scheduling.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION: "Thoughts on compute capacity, distributed systems, and AI infrastructure.",
};

export const WORK: Metadata = {
  TITLE: "Work",
  DESCRIPTION: "Where I have worked and what I have done.",
};

export const PROJECTS: Metadata = {
  TITLE: "Projects",
  DESCRIPTION: "A collection of my projects.",
};

export const SOCIALS: Socials = [
  { 
    NAME: "linkedin",
    HREF: "https://www.linkedin.com/in/mincan-yang/",
  },
  { 
    NAME: "github",
    HREF: "https://github.com/mincan-yang"
  },
];
