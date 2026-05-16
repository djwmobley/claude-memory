"""leiden_communities.py — Bundle B Workstream 3

Reads a graph from stdin as JSON and runs Leiden community detection.

Input (stdin):
    {
        "nodes": ["entity_name", ...],
        "edges": [["from", "to", weight], ...]
    }

Output (stdout, JSON):
    {"entity_name": <community_int>, ...}

Exit codes:
    0  success
    1  unexpected error (details on stderr)
    2  bad input (malformed JSON or missing keys)
    3  deps missing (leidenalg or igraph not importable)

Requires Python 3, leidenalg, python-igraph.
Install: pip install leidenalg python-igraph
"""

import json
import sys


def main():
    # Attempt imports — distinct exit code on failure so the Node driver can
    # distinguish "deps missing" (non-fatal no-op) from other errors.
    try:
        import igraph
        import leidenalg
    except ImportError as e:
        sys.stderr.write(
            f'[leiden_communities] deps missing: {e}\n'
            'Install: pip install leidenalg python-igraph\n'
        )
        sys.exit(3)

    # Read and parse stdin.
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        nodes = payload['nodes']
        edges = payload['edges']
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        sys.stderr.write(f'[leiden_communities] bad input: {e}\n')
        sys.exit(2)

    if not nodes:
        sys.stderr.write('[leiden_communities] no nodes in payload\n')
        sys.exit(2)

    # Build undirected igraph Graph with optional edge weights.
    g = igraph.Graph()
    g.add_vertices(len(nodes))
    g.vs['name'] = list(nodes)

    # Build a name->index map for fast edge lookup.
    name_to_idx = {name: i for i, name in enumerate(nodes)}

    edge_list = []
    weights = []
    for e in edges:
        if len(e) < 2:
            continue
        src = e[0]
        dst = e[1]
        w = float(e[2]) if len(e) > 2 else 1.0
        if src in name_to_idx and dst in name_to_idx:
            edge_list.append((name_to_idx[src], name_to_idx[dst]))
            weights.append(w)

    if edge_list:
        g.add_edges(edge_list)
        g.es['weight'] = weights

    # Run Leiden community detection.
    try:
        partition = leidenalg.find_partition(
            g,
            leidenalg.ModularityVertexPartition,
            weights='weight' if edge_list else None,
        )
    except Exception as e:
        sys.stderr.write(f'[leiden_communities] leidenalg error: {e}\n')
        sys.exit(1)

    # Emit {entity_name: community_int} mapping.
    result = {}
    for community_id, member_indices in enumerate(partition):
        for idx in member_indices:
            result[nodes[idx]] = community_id

    json.dump(result, sys.stdout)
    sys.stdout.write('\n')
    sys.exit(0)


if __name__ == '__main__':
    main()
