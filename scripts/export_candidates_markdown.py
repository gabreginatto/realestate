#!/usr/bin/env python3
"""
Export vector search candidates to markdown for manual review.

This script:
1. Loads candidate pairs from vector search JSON
2. Fetches property metadata from manifests
3. Generates markdown report with images and details
4. Allows manual verification before Gemini API calls

Usage:
    python scripts/export_candidates_markdown.py data/vector_search_candidates.json
"""

import argparse
import json
import os
from pathlib import Path
from typing import Dict, List, Optional
from rich.console import Console

console = Console()


def load_manifest(site: str, listing_id: str) -> Optional[Dict]:
    """
    Load _manifest.json for a listing.

    Args:
        site: Site name (e.g., 'coelhodafonseca')
        listing_id: Listing ID (e.g., '302330')

    Returns:
        Manifest dict or None if not found
    """
    manifest_path = f"selected_exteriors/{site}/{listing_id}/_manifest.json"

    if not os.path.exists(manifest_path):
        return None

    try:
        with open(manifest_path, 'r') as f:
            return json.load(f)
    except Exception as e:
        console.print(f"[yellow]Warning: Could not load manifest for {site}/{listing_id}: {e}[/yellow]")
        return None


def get_image_paths(site: str, listing_id: str) -> List[str]:
    """
    Get relative paths to selected exterior images.

    Args:
        site: Site name
        listing_id: Listing ID

    Returns:
        List of relative image paths
    """
    listing_dir = f"selected_exteriors/{site}/{listing_id}"

    if not os.path.exists(listing_dir):
        return []

    images = []
    for file in sorted(os.listdir(listing_dir)):
        if file.endswith(('.jpg', '.jpeg', '.png')) and not file.startswith('_'):
            images.append(f"{listing_dir}/{file}")

    return images


def generate_markdown_report(candidates: List[Dict], output_file: str):
    """
    Generate markdown report of candidate pairs.

    Args:
        candidates: List of candidate pair dicts
        output_file: Output markdown file path
    """
    console.print(f"[cyan]Generating markdown report: {output_file}[/cyan]")

    # Group candidates by source listing
    grouped = {}
    for candidate in candidates:
        source_id = candidate['source_listing_id']
        if source_id not in grouped:
            grouped[source_id] = []
        grouped[source_id].append(candidate)

    # Generate markdown
    md_lines = [
        "# Vector Search Candidate Pairs - Manual Review",
        "",
        f"**Total Candidates:** {len(candidates)} pairs",
        f"**Source Listings:** {len(grouped)} Coelho da Fonseca properties",
        "",
        "---",
        "",
        "## Instructions",
        "",
        "For each candidate pair below:",
        "1. Review the similarity score (higher % = more similar)",
        "2. Click image links to view side-by-side",
        "3. Check if properties appear to be the same building",
        "4. Mark your assessment: ✅ MATCH / ❌ NO MATCH / ❓ UNCERTAIN",
        "",
        "---",
        ""
    ]

    # Process each source listing
    for idx, (source_id, matches) in enumerate(sorted(grouped.items()), 1):
        source_site = matches[0]['source_site']

        # Load source manifest
        source_manifest = load_manifest(source_site, source_id)
        source_images = get_image_paths(source_site, source_id)

        md_lines.append(f"## {idx}. Coelho da Fonseca #{source_id}")
        md_lines.append("")

        # Source property details
        if source_manifest:
            md_lines.append("**Source Property:**")
            md_lines.append(f"- Total images: {source_manifest.get('total_images', 'N/A')}")
            md_lines.append(f"- Selected images: {source_manifest.get('selected_count', 'N/A')}")
            md_lines.append("")

        # Source images (first 4 thumbnails)
        if source_images:
            md_lines.append("**Source Images (first 4):**")
            md_lines.append("")
            for img_path in source_images[:4]:
                md_lines.append(f"![Coelho {source_id}]({img_path})")
            md_lines.append("")
            md_lines.append(f"[View all {len(source_images)} images →](selected_exteriors/{source_site}/{source_id}/)")
            md_lines.append("")

        # Candidate matches
        md_lines.append(f"**Candidate Matches ({len(matches)}):**")
        md_lines.append("")

        for match_idx, match in enumerate(matches, 1):
            target_site = match['target_site']
            target_id = match['target_listing_id']
            distance = match['vector_distance']
            similarity = match['similarity_score']

            # Load target manifest
            target_manifest = load_manifest(target_site, target_id)
            target_images = get_image_paths(target_site, target_id)

            md_lines.append(f"### Match {match_idx}: Viva Prime #{target_id}")
            md_lines.append("")
            md_lines.append(f"**Similarity:** {similarity:.1f}% (distance: {distance:.4f})")
            md_lines.append("")

            # Target property details
            if target_manifest:
                md_lines.append(f"- Total images: {target_manifest.get('total_images', 'N/A')}")
                md_lines.append(f"- Selected images: {target_manifest.get('selected_count', 'N/A')}")
                md_lines.append("")

            # Target images (first 4 thumbnails)
            if target_images:
                md_lines.append("**Target Images (first 4):**")
                md_lines.append("")
                for img_path in target_images[:4]:
                    md_lines.append(f"![Viva {target_id}]({img_path})")
                md_lines.append("")
                md_lines.append(f"[View all {len(target_images)} images →](selected_exteriors/{target_site}/{target_id}/)")
                md_lines.append("")

            # Manual assessment checkbox
            md_lines.append("**Manual Assessment:**")
            md_lines.append("- [ ] ✅ MATCH (same property)")
            md_lines.append("- [ ] ❌ NO MATCH (different properties)")
            md_lines.append("- [ ] ❓ UNCERTAIN (cannot determine)")
            md_lines.append("")
            md_lines.append("**Notes:**")
            md_lines.append("")
            md_lines.append("_[Add your observations here]_")
            md_lines.append("")
            md_lines.append("---")
            md_lines.append("")

        md_lines.append("")
        md_lines.append("---")
        md_lines.append("")

    # Summary section
    md_lines.append("## Summary Statistics")
    md_lines.append("")
    md_lines.append("| Metric | Value |")
    md_lines.append("|--------|-------|")
    md_lines.append(f"| Total candidate pairs | {len(candidates)} |")
    md_lines.append(f"| Unique Coelho listings | {len(grouped)} |")

    # Calculate avg matches per listing
    avg_matches = len(candidates) / len(grouped) if grouped else 0
    md_lines.append(f"| Avg matches per Coelho listing | {avg_matches:.1f} |")

    # Distance/similarity stats
    distances = [c['vector_distance'] for c in candidates]
    similarities = [c['similarity_score'] for c in candidates]

    md_lines.append(f"| Min distance | {min(distances):.4f} |")
    md_lines.append(f"| Max distance | {max(distances):.4f} |")
    md_lines.append(f"| Avg similarity | {sum(similarities)/len(similarities):.1f}% |")
    md_lines.append("")
    md_lines.append("---")
    md_lines.append("")
    md_lines.append("## Next Steps")
    md_lines.append("")
    md_lines.append("After manual review:")
    md_lines.append("1. Assess accuracy of vector search")
    md_lines.append("2. If accuracy is good, proceed with Gemini verification")
    md_lines.append("3. If accuracy is poor, adjust threshold or top-k parameters")
    md_lines.append("")
    md_lines.append("Run Gemini verification:")
    md_lines.append("```bash")
    md_lines.append("export GEMINI_API_KEY='your-api-key'")
    md_lines.append("python scripts/verify_matches_gemini.py data/vector_search_candidates.json")
    md_lines.append("```")

    # Write to file
    with open(output_file, 'w') as f:
        f.write('\n'.join(md_lines))

    console.print(f"[green]✓ Markdown report generated: {output_file}[/green]")
    console.print(f"[cyan]Review the file to manually assess candidate quality[/cyan]")


def main():
    parser = argparse.ArgumentParser(description="Export candidates to markdown for manual review")
    parser.add_argument(
        "input_file",
        type=str,
        help="Input JSON file with candidate pairs",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="CANDIDATE-PAIRS-REVIEW.md",
        help="Output markdown file",
    )

    args = parser.parse_args()

    console.print("[bold cyan]📝 Candidate Pairs Markdown Export[/bold cyan]")
    console.print(f"Input: {args.input_file}")
    console.print(f"Output: {args.output}")
    console.print("")

    # Load candidates
    if not os.path.exists(args.input_file):
        console.print(f"[red]Error: Input file not found: {args.input_file}[/red]")
        return

    with open(args.input_file, 'r') as f:
        candidates = json.load(f)

    console.print(f"[cyan]Loaded {len(candidates)} candidate pairs[/cyan]")
    console.print("")

    # Generate markdown
    generate_markdown_report(candidates, args.output)

    console.print("")
    console.print("[bold green]✓ Export complete![/bold green]")
    console.print(f"[cyan]Open {args.output} to review candidates manually[/cyan]")


if __name__ == "__main__":
    main()
