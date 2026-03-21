pragma solidity ^0.8.0;
      contract TestUSDT {
          string  public name     = "Test USDT";
          string  public symbol   = "TUSDT";
          uint8   public decimals = 6;
          uint256 public totalSupply;
          mapping(address => uint256) public balanceOf;
          mapping(address => mapping(address => uint256)) public allowance;
          event Transfer(address indexed from, address indexed to, uint256 value);
          event Approval(address indexed owner, address indexed spender, uint256 value);
          constructor(uint256 initialSupply) {
              totalSupply = initialSupply * 10**6;
              balanceOf[msg.sender] = totalSupply;
              emit Transfer(address(0), msg.sender, totalSupply);
          }
          function transfer(address to, uint256 amount) public returns (bool) {
              require(balanceOf[msg.sender] >= amount, "insufficient");
              balanceOf[msg.sender] -= amount;
              balanceOf[to] += amount;
              emit Transfer(msg.sender, to, amount);
              return true;
          }
          function approve(address spender, uint256 amount) public returns (bool) {
              allowance[msg.sender][spender] = amount;
              emit Approval(msg.sender, spender, amount);
              return true;
          }
          function transferFrom(address from, address to, uint256 amount) public returns (bool) {
              require(balanceOf[from] >= amount, "insufficient");
              require(allowance[from][msg.sender] >= amount, "not approved");
              allowance[from][msg.sender] -= amount;
              balanceOf[from] -= amount;
              balanceOf[to] += amount;
              emit Transfer(from, to, amount);
              return true;
          }
      }
