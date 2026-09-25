// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockV2Factory {
    mapping(bytes32 => address) public pairs;
    function setPair(address a, address b, address pair) external {
        pairs[keccak256(abi.encodePacked(a, b))] = pair;
        pairs[keccak256(abi.encodePacked(b, a))] = pair;
    }
    function getPair(address a, address b) external view returns (address) {
        return pairs[keccak256(abi.encodePacked(a, b))];
    }
}

contract MockV3Factory {
    mapping(bytes32 => address) public pools;
    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encodePacked(a, b, fee))] = pool;
        pools[keccak256(abi.encodePacked(b, a, fee))] = pool;
    }
    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encodePacked(a, b, fee))];
    }
}
