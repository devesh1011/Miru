# DeepMirror Documentation

Comprehensive documentation for the DeepMirror Telegram bot - copy trading on DeepBook V3.

## 📚 Documentation Structure

```
docs/
├── mint.json                    # Mintlify configuration
├── introduction.mdx             # Overview and features
├── quickstart.mdx               # 60-second getting started guide
│
├── bot/                         # Bot guide section
│   ├── wallet.mdx               # Wallet management and zkLogin
│   ├── zklogin.mdx              # Deep dive into zkLogin auth
│   ├── copy-trading.mdx         # Copy trading setup and strategies
│   ├── positions.mdx            # Position tracking and management
│   └── commands.mdx             # Complete command reference
│
└── advanced/                    # Advanced topics
    ├── deepbook-v3.mdx          # DeepBook V3 protocol explanation
    ├── fees.mdx                 # Gas and trading fee breakdown
    ├── security.mdx             # Security best practices
    └── troubleshooting.mdx      # Common issues and solutions
```

## 🚀 Getting Started with Mintlify

### Prerequisites

- Node.js v20.17.0 or higher
- npm or pnpm package manager

### Installation

```bash
# Install Mintlify CLI globally
npm install -g mintlify

# Or with pnpm
pnpm add -g mintlify
```

### Local Development

```bash
# Navigate to docs directory
cd docs

# Start local preview server
mintlify dev

# Open http://localhost:3000
```

### Deployment

#### Option 1: Mintlify Cloud (Recommended)

1. Go to [mintlify.com/start](https://mintlify.com/start)
2. Connect your GitHub repository
3. Select the `docs` folder as documentation root
4. Deploy automatically on every push

#### Option 2: Self-Hosted

```bash
# Build static site
mintlify build

# Output in .mintlify directory
# Deploy to any static hosting (Vercel, Netlify, Cloudflare Pages)
```

## 📝 Writing Documentation

### Page Structure

Every MDX page includes frontmatter:

```mdx
---
title: "Page Title"
description: "Brief description for SEO and page header"
---

# Page Title

Content goes here...
```

### Using Components

Mintlify provides rich components:

```mdx
<Card title="Title" icon="icon-name" href="/link">
  Card content
</Card>

<Tip>
  Helpful tip for users
</Tip>

<Warning>
  Important warning
</Warning>

<Info>
  Additional information
</Info>

<AccordionGroup>
  <Accordion title="Question">
    Answer
  </Accordion>
</AccordionGroup>
```

### Code Blocks

```mdx
\`\`\`typescript
// Code with syntax highlighting
const example = "code";
\`\`\`

\`\`\`bash
# Shell commands
npm install
\`\`\`
```

## 🎨 Customization

### Update Configuration

Edit `mint.json` to change:

- **Theme**: `quill`, `prism`, `mint`, `maple`
- **Colors**: Primary, light, dark
- **Navigation**: Add/remove pages
- **Logo**: Replace logo files
- **Footer**: Social links

### Add New Pages

1. Create `.mdx` file in appropriate directory
2. Add frontmatter with title and description
3. Update `mint.json` navigation:

```json
{
  "navigation": [
    {
      "group": "Group Name",
      "pages": [
        "path/to/page"  // Add new page here
      ]
    }
  ]
}
```

### Add Images

1. Place images in `docs/images/` directory
2. Reference in MDX:

```mdx
![Alt text](/images/screenshot.png)
```

## 🔧 Maintenance

### Link Checking

```bash
# Find broken links
mintlify broken-links
```

### Spell Checking

Use a spell checker extension in your editor or:

```bash
# Install cspell
npm install -g cspell

# Run spell check
cspell "**/*.mdx"
```

### Content Updates

When updating documentation:

1. Make changes to `.mdx` files
2. Test locally with `mintlify dev`
3. Commit and push to GitHub
4. Mintlify automatically redeploys

## 📖 Content Guidelines

### Writing Style

- **Clear and concise**: Short sentences, active voice
- **User-focused**: Address users as "you"
- **Examples**: Show real-world usage
- **Progressive disclosure**: Start simple, add complexity gradually

### Structure

Each guide should include:

1. **Overview**: What and why
2. **Quick example**: Show the end result
3. **Step-by-step**: Detailed instructions
4. **Troubleshooting**: Common issues
5. **Next steps**: Related pages

### Accessibility

- Use descriptive link text (not "click here")
- Add alt text to all images
- Maintain heading hierarchy (h1 → h2 → h3)
- Use semantic HTML

## 🌐 Deployment URLs

After deployment, documentation will be available at:

- **Mintlify subdomain**: `deepmirror.mintlify.app`
- **Custom domain** (optional): `docs.deepmirror.xyz`

### Custom Domain Setup

1. Add domain in Mintlify dashboard
2. Create CNAME record:
   ```
   docs.deepmirror.xyz → deepmirror.mintlify.app
   ```
3. Wait for DNS propagation (up to 48 hours)

## 📞 Support

### Documentation Issues

- **Typos/Errors**: Open PR with fix
- **Missing content**: Create GitHub issue with details
- **Suggestions**: Discuss in community channel

### Mintlify Support

- [Mintlify Docs](https://mintlify.com/docs)
- [Community Slack](https://mintlify.com/community)
- [Email Support](mailto:support@mintlify.com)

## 🤝 Contributing

To contribute to documentation:

1. Fork the repository
2. Create feature branch: `git checkout -b docs/your-feature`
3. Make changes to `.mdx` files
4. Test locally: `mintlify dev`
5. Commit: `git commit -m "docs: description"`
6. Push: `git push origin docs/your-feature`
7. Open Pull Request

## 📜 License

Documentation is licensed under MIT License - see [LICENSE](../LICENSE) file.

---

**Built with ❤️ using [Mintlify](https://mintlify.com)**
