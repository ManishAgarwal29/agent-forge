// Starting points. Each is fictional, so nothing in it can be mistaken for real facts:
// the visitor replaces the facts with their own.
import { Project } from "./project.js";

const REPLACE = "SAMPLE FACTS: replace everything below with your own.\n";

export const TEMPLATES = [
  {
    id: "blank",
    title: "Blank site",
    blurb: "One agent and no facts. Start from your own content.",
    build: () => Project.blank(),
  },
  {
    id: "cafe",
    title: "Cafe or restaurant",
    blurb: "A menu with dietary details and opening hours, and a specialist for allergy questions.",
    build: () => new Project({
      brand: "Corner Cafe Assistant",
      networkName: "corner_cafe",
      description: "Ask about the Corner Cafe menu, prices, allergens and opening hours.",
      sampleQueries: ["What vegan dishes do you have?", "Is the soup gluten free?", "When do you close on Sundays?", "Can I book a table for six?"],
      notSupported: "take orders, reserve tables or take payments.",
      facts: `${REPLACE}Corner Cafe, 12 Mill Street.\nOpen every day 8:00 to 17:00. Closed on 25 December.\nMenu (US dollars):\n- Tomato Soup, 6.50. Vegan. Gluten free.\n- Cheese Toastie, 7.00. Vegetarian. Contains milk and wheat.\n- Lentil Bowl, 9.00. Vegan. Contains sesame.\n- Carrot Cake, 4.50. Vegetarian. Contains eggs, milk, wheat and walnuts.\n- Filter Coffee, 3.00. Vegan.`,
      agents: [
        { name: "cafe_host", description: "Answers questions about the cafe and routes allergy questions to the allergen expert.", instructions: "You are the host of Corner Cafe. Answer questions about the menu, prices and hours in short, friendly sentences. For any question about allergies or dietary needs, ask allergen_expert and pass on its answer.", useFacts: true, tools: ["allergen_expert"] },
        { name: "allergen_expert", description: "Answers allergy and dietary questions about each dish.", instructions: "You help the cafe host with allergens and dietary labels. Your answer goes to the host, not to the visitor. If the facts do not list an allergen for a dish, say it is not known and that the visitor should ask staff.", useFacts: true, tools: [] },
      ],
      front: "cafe_host",
    }),
  },
  {
    id: "service",
    title: "Local service business",
    blurb: "Services, prices, service area and how to book, with a pricing specialist.",
    build: () => new Project({
      brand: "Bright Bikes Assistant",
      networkName: "bright_bikes",
      description: "Ask about Bright Bikes repair services, prices, opening hours and how to book.",
      sampleQueries: ["How much is a puncture repair?", "Do you collect bikes?", "How long does a full service take?"],
      notSupported: "book repairs, check the status of a repair or take payments.",
      facts: `${REPLACE}Bright Bikes, a bicycle repair shop at 4 Canal Row.\nOpen Monday to Saturday 9:00 to 18:00.\nServices and prices (US dollars): puncture repair 15; brake adjustment 20; basic service 55; full service 120 (about 3 working days).\nFree collection within 3 miles for full services.\nTo book: call the shop or use the booking form on the contact page.`,
      agents: [
        { name: "shop_assistant", description: "Answers questions about the shop's services, hours and booking.", instructions: "You are the assistant for Bright Bikes. Help visitors understand what the shop does and what it costs. For price questions, ask price_helper.", useFacts: true, tools: ["price_helper"] },
        { name: "price_helper", description: "Works out the price for one or more services.", instructions: "You work out prices for the shop assistant. Add up the listed prices exactly. Show each line and the total. If a service is not listed, say so. Your answer goes to the assistant, not to the visitor.", useFacts: true, tools: [] },
      ],
      front: "shop_assistant",
    }),
  },
  {
    id: "docs",
    title: "Documentation or FAQ",
    blurb: "Answers from the product's docs and says when the docs do not cover a question.",
    build: () => new Project({
      brand: "Docs Assistant",
      networkName: "docs_guide",
      description: "Ask how to install, configure and troubleshoot the product.",
      sampleQueries: ["How do I install it?", "Why do I get a permission error?", "Which versions are supported?"],
      notSupported: "debug the visitor's own code or access their account.",
      facts: `${REPLACE}Product: Sparrow CLI, a tool that syncs folders.\nInstall: npm install -g sparrow-cli (needs Node 20 or newer).\nSupported versions: 3.x receives fixes. 2.x is end of life.\nCommon error: EACCES means the folder is not writable. Run sparrow doctor to see which folder.\nConfig file: sparrow.json in the project folder. Key "ignore" lists paths to skip.`,
      agents: [
        { name: "docs_guide", description: "Answers questions about installing, configuring and troubleshooting the product, from the docs.", instructions: "You answer questions from the product documentation. Give the exact command or setting. If the docs do not cover the question, say so and suggest the issue tracker.", useFacts: true, tools: [] },
      ],
      front: "docs_guide",
    }),
  },
];

export function getTemplate(id) {
  return TEMPLATES.find(template => template.id === id) || null;
}
